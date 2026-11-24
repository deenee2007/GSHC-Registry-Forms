/*
 * src/routes/cashflow.js — the monthly cash flow.
 *
 *   Requesters (the CJ's aide, the Chief Registrar, the DCR Admin and
 *   Finance) put items on the month's cash flow. The Hon. Chief Judge
 *   approves each (in full or a lower amount, with the signing PIN),
 *   declines it, or returns it with a query, which the requester answers
 *   and sends back. The Accountant records the payment of approved items.
 *   An item not approved is carried to the next cash flow or dismissed, by
 *   the Chief Judge or, if left to them, the requester.
 *
 * Who sees what: the Chief Judge, the CJ's aide, the Chief Registrar and
 * the DCR Admin and Finance see every item; the Accountant, the approved
 * ones; only the Chief Judge sees the money (released, balance).
 */
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { CashItem, CashSheet, User, Notification } = require('../models');
const crypto = require('crypto');
const verification = require('../services/verification');
const cf = require('../services/cashflow');
const fileStore = require('../services/fileStore');
const store = require('../services/signatureStore');
const audit = require('../services/audit');
const mail = require('../services/mail');
const settings = require('../services/settings');
const { verifyPin } = require('./me');
const { HttpError, requireLogin, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: fileStore.DOC_MAX_BYTES, files: 5 } }).array('files', 5);
const files = (req, res, next) => upload(req, res, (err) => next(err && err.code === 'LIMIT_FILE_SIZE' ? new HttpError(400, 'Each attachment must be under 10 MB.') : err));

const REQUESTERS = ['cj_aide', 'chief_registrar', 'dcr_admin_finance'];
const has = (u, roles) => (u.signerRoles || []).some(r => roles.includes(r));
const isCJ = (u) => has(u, ['chief_judge']);
const isRequester = (u) => has(u, REQUESTERS);
const isAccountant = (u) => has(u, ['accountant']);
// The administrator sees everything (the money too), to oversee; acting is for the officers.
const seesAll = (u) => isCJ(u) || isRequester(u) || isAdmin(u);
const seesMoney = (u) => isCJ(u) || isAdmin(u);
const mine = (u, it) => String(it.requestedBy) === String(u._id);
const roleOf = (u) => ['cj_aide', 'chief_registrar', 'dcr_admin_finance'].find(r => u.signerRoles.includes(r)) || '';
const ROLE_NAME = { cj_aide: 'Aide to the Hon. Chief Judge', chief_registrar: 'Chief Registrar', dcr_admin_finance: 'DCR Admin and Finance' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function mustUse(u) {
  if (!seesAll(u) && !isAccountant(u)) throw new HttpError(403, 'The cash flow is for the Hon. Chief Judge, the CJ\'s aide, the Chief Registrar, the DCR Admin and Finance and the Accountant.');
}
async function load(id, u) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Item not found.');
  const it = await CashItem.findById(id);
  if (!it) throw new HttpError(404, 'Item not found.');
  if (!seesAll(u) && !(isAccountant(u) && ['approved', 'paid'].includes(it.status))) throw new HttpError(403, 'You do not have access to this item.');
  return it;
}

function serialize(it, u) {
  const o = it.toObject ? it.toObject() : it;
  const cj = isCJ(u);
  return {
    id: String(o._id), month: o.month, monthName: cf.monthName(o.month), sn: o.sn, item: o.item, description: o.description,
    quantity: o.quantity, unitPrice: o.unitPrice, amount: o.amount, department: o.department, justification: o.justification,
    attachments: (o.attachments || []).map((a, i) => ({ name: a.name, url: `/api/cashflow/${o._id}/files/${i}` })),
    status: o.status, requestedBy: String(o.requestedBy), requestedByName: o.requestedByName, requestedByRole: ROLE_NAME[o.requestedByRole] || '',
    query: o.query, carriedFrom: o.carriedFrom ? cf.monthName(o.carriedFrom) : '', requesterDecides: !!o.requesterDecides,
    decision: o.decision ? { kind: o.decision.kind, amount: o.decision.amount, note: o.decision.note, byName: o.decision.byName, title: o.decision.title, at: o.decision.at,
      signatureUrl: o.decision.image ? `/api/cashflow/${o._id}/signature` : null } : null,
    payment: o.payment, history: [...(o.history || [])].reverse(), createdAt: o.createdAt,
    can: {
      decide: cj && ['pending'].includes(o.status),
      answer: mine(u, o) && o.status === 'returned',
      carry: o.status === 'declined' && (cj || (mine(u, o) && o.requesterDecides)),
      pay: isAccountant(u) && o.status === 'approved'
    }
  };
}

// In app notices, and an email where the person allows alerts.
async function tell(users, message, subject) {
  const list = users.filter(Boolean);
  if (!list.length) return;
  await Notification.insertMany(list.map(x => ({ user: x._id, kind: 'cashflow', link: 'cashflow', message })));
  try {
    if (!mail.enabled() || !(await settings.get()).emailAlerts) return;
    await Promise.allSettled(list.filter(x => x.email && x.emailAlerts !== false && !x.emailAlertsBlocked)
      .map(x => mail.send({ to: x.email, name: x.fullName, ...mail.alertMessage(x, subject, message, '') })));
  } catch (e) { console.error('Cash flow alert emails failed:', e.message); }
}
const holders = (role, not) => User.find({ active: true, kind: { $ne: 'personal' }, signerRoles: role, ...(not ? { _id: { $ne: not } } : {}) });
const requester = (it) => User.find({ _id: it.requestedBy, active: true });

async function saveFiles(req) {
  const out = [];
  for (const f of req.files || []) {
    try { out.push({ name: text(f.originalname, 120), file: await fileStore.save(f.buffer, f.originalname, 'cashflow') }); }
    catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: true }); }
  }
  return out;
}
function cleanFields(b) {
  const item = text(b.item, 200);
  if (!item) throw new HttpError(400, 'Enter the item requested.');
  const qty = b.quantity === '' || b.quantity == null ? null : Number(b.quantity);
  const unit = b.unitPrice === '' || b.unitPrice == null ? null : Number(b.unitPrice);
  let amount = Number(b.amount);
  if (qty !== null && unit !== null) {
    if (!(qty > 0) || !(unit >= 0)) throw new HttpError(400, 'Enter the quantity and the unit price as numbers.');
    amount = Math.round(qty * unit * 100) / 100;
  }
  if (!(amount > 0) || amount > 1e13) throw new HttpError(400, 'Enter the amount requested, in naira.');
  return { item, description: text(b.description, 3000), quantity: qty, unitPrice: unit, amount: Math.round(amount * 100) / 100,
    department: text(b.department, 200), justification: text(b.justification, 3000) };
}

// ── Who I am here, and the month ──
router.get('/me', wrap(async (req, res) => {
  await cf.rollOver();
  res.json({ month: cf.thisMonth(), monthName: cf.monthName(cf.thisMonth()), cj: isCJ(req.user), seesMoney: seesMoney(req.user), requester: isRequester(req.user),
    accountant: isAccountant(req.user), seesAll: seesAll(req.user), admin: isAdmin(req.user) });
}));

// Waiting for this person: the CJ's decisions, the Accountant's payments, a requester's queries.
router.get('/counts', wrap(async (req, res) => {
  const u = req.user;
  const n = isCJ(u) ? await CashItem.countDocuments({ status: 'pending' })
    : isAccountant(u) ? await CashItem.countDocuments({ status: 'approved' })
    : isRequester(u) ? await CashItem.countDocuments({ requestedBy: u._id, status: 'returned' }) : 0;
  res.json({ waiting: n });
}));

// A month's cash flow (the money only for the Chief Judge).
router.get('/', wrap(async (req, res) => {
  mustUse(req.user);
  await cf.rollOver();
  const month = cf.MONTH.test(req.query.month || '') ? req.query.month : cf.thisMonth();
  const q = { month, status: { $ne: 'dismissed' } };
  if (!seesAll(req.user)) q.status = { $in: ['approved', 'paid'] };
  const list = await CashItem.find(q).sort({ sn: 1 });
  const months = (await CashItem.distinct('month')).concat(Object.keys(await cf.releases()), [cf.thisMonth()]);
  res.json({ month, monthName: cf.monthName(month), items: list.map(x => serialize(x, req.user)),
    months: [...new Set(months)].sort().reverse().map(m => ({ month: m, name: cf.monthName(m) })),
    summary: seesMoney(req.user) ? await cf.summary(month) : null });
}));

// A requester's own items, every month.
router.get('/mine', wrap(async (req, res) => {
  if (!isRequester(req.user)) throw new HttpError(403, 'For those who request items on the cash flow.');
  const list = await CashItem.find({ requestedBy: req.user._id }).sort({ createdAt: -1 }).limit(500);
  res.json({ items: list.map(x => serialize(x, req.user)) });
}));

router.get('/:id', wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  res.json({ item: serialize(it, req.user) });
}));

// A new request: straight onto this month's cash flow.
router.post('/', files, wrap(async (req, res) => {
  if (!isRequester(req.user)) throw new HttpError(403, 'Only the CJ\'s aide, the Chief Registrar and the DCR Admin and Finance request items on the cash flow.');
  await cf.rollOver();
  const fields = cleanFields(req.body || {});
  const month = cf.thisMonth();
  const it = await CashItem.create({ ...fields, month, sn: await cf.nextSn(month), attachments: await saveFiles(req),
    requestedBy: req.user._id, requestedByName: req.user.fullName, requestedByRole: roleOf(req.user),
    history: [{ action: 'requested', byName: req.user.fullName, note: money(fields.amount), at: new Date() }] });
  await audit.log(req, 'cashflow_requested', { details: { itemId: String(it._id), month, item: it.item, amount: it.amount } });
  await tell(await holders('chief_judge', req.user._id), `${req.user.fullName} (${ROLE_NAME[roleOf(req.user)]}) put ${it.item}, ${money(it.amount)}, on the ${cf.monthName(month)} cash flow.`, 'Cash flow: new request');
  res.status(201).json({ item: serialize(it, req.user) });
}));

// The requester answers a query (and may correct the item), and sends it back.
router.put('/:id', files, wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  if (!mine(req.user, it) || it.status !== 'returned') throw new HttpError(409, 'Only an item returned to you with a query can be changed and sent back.');
  const answer = text(req.body.answer, 2000);
  if (!answer) throw new HttpError(400, 'Answer the query.');
  Object.assign(it, cleanFields({ ...it.toObject(), ...req.body }));
  it.attachments.push(...await saveFiles(req));
  it.status = 'pending';
  it.history.push({ action: 'answered', byName: req.user.fullName, note: answer, at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_answered', { details: { itemId: String(it._id), answer } });
  await tell(await holders('chief_judge', req.user._id), `${req.user.fullName} answered your query on ${it.item} (${money(it.amount)}): ${answer}`, 'Cash flow: query answered');
  res.json({ item: serialize(it, req.user) });
}));

// The Chief Judge: approve (in full or less, with the PIN), decline, or return with a query.
router.post('/:id/decide', wrap(async (req, res) => {
  if (!isCJ(req.user)) throw new HttpError(403, 'Only the Hon. Chief Judge decides on the cash flow.');
  const it = await load(req.params.id, req.user);
  if (it.status !== 'pending') throw new HttpError(409, 'This item is not waiting for a decision.');
  const action = String(req.body.action || '');
  const note = text(req.body.note, 2000);
  const me = req.user;
  if (action === 'approve') {
    const amount = req.body.amount === undefined || req.body.amount === '' ? it.amount : Math.round(Number(req.body.amount) * 100) / 100;
    if (!(amount > 0)) throw new HttpError(400, 'Enter the amount approved.');
    if (amount > it.amount) throw new HttpError(400, `The amount approved cannot be more than the ${money(it.amount)} requested.`);
    if (!me.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
    await verifyPin(me, req.body.pin);
    it.decision = { kind: 'approved', amount, note, by: me._id, byName: me.fullName, title: me.title, at: new Date(), image: me.signature };
    it.status = 'approved';
    it.history.push({ action: 'approved', byName: me.fullName, note: amount < it.amount ? `${money(amount)} of ${money(it.amount)}${note ? `. ${note}` : ''}` : `${money(amount)}${note ? `. ${note}` : ''}`, at: new Date() });
  } else if (action === 'decline') {
    it.decision = { kind: 'declined', amount: 0, note, by: me._id, byName: me.fullName, title: me.title, at: new Date() };
    it.status = 'declined';
    it.requesterDecides = !!req.body.requesterDecides;
    it.history.push({ action: 'declined', byName: me.fullName, note: [note, it.requesterDecides ? 'The requester to carry it forward or dismiss it' : ''].filter(Boolean).join('. '), at: new Date() });
  } else if (action === 'return') {
    if (!note) throw new HttpError(400, 'Write the query.');
    it.query = { text: note, byName: me.fullName, at: new Date() };
    it.status = 'returned';
    it.history.push({ action: 'returned', byName: me.fullName, note, at: new Date() });
  } else throw new HttpError(400, 'Approve, decline or return with a query.');
  await it.save();
  await audit.log(req, `cashflow_${it.status}`, { details: { itemId: String(it._id), item: it.item, amount: it.decision ? it.decision.amount : undefined, note } });
  const what = `${it.item} (${money(it.amount)})`;
  if (it.status === 'approved') {
    await tell(await requester(it), `The Hon. Chief Judge approved ${what}${it.decision.amount < it.amount ? `: ${money(it.decision.amount)}` : ''}.`, 'Cash flow: approved');
    await tell(await holders('accountant'), `Approved for payment: ${it.item}, ${money(it.decision.amount)} (${it.monthName || cf.monthName(it.month)} cash flow, requested by ${it.requestedByName}).`, 'Cash flow: approved for payment');
  } else if (it.status === 'declined') {
    await tell(await requester(it), `The Hon. Chief Judge did not approve ${what}${note ? `: ${note}` : ''}.${it.requesterDecides ? ' Carry it to the next cash flow or dismiss it.' : ''}`, 'Cash flow: not approved');
  } else {
    await tell(await requester(it), `The Hon. Chief Judge returned ${what} with a query: ${note}`, 'Cash flow: query');
  }
  res.json({ item: serialize(it, req.user) });
}));

// An item not approved: carried to the next cash flow, or dismissed.
router.post('/:id/carry', wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  if (it.status !== 'declined' || !(isCJ(req.user) || (mine(req.user, it) && it.requesterDecides))) throw new HttpError(403, 'Only the Hon. Chief Judge (or the requester, if left to them) carries an item not approved.');
  const to = [cf.nextMonth(it.month), cf.thisMonth()].sort().pop();
  const from = it.month;
  Object.assign(it, { month: to, sn: await cf.nextSn(to), status: 'pending', carriedFrom: from, requesterDecides: false });
  it.history.push({ action: 'carried', byName: req.user.fullName, note: `Carried from ${cf.monthName(from)} to the ${cf.monthName(to)} cash flow`, at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_carried', { details: { itemId: String(it._id), from, to } });
  res.json({ item: serialize(it, req.user) });
}));

router.post('/:id/dismiss', wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  if (it.status !== 'declined' || !(isCJ(req.user) || (mine(req.user, it) && it.requesterDecides))) throw new HttpError(403, 'Only the Hon. Chief Judge (or the requester, if left to them) dismisses an item not approved.');
  it.status = 'dismissed';
  it.history.push({ action: 'dismissed', byName: req.user.fullName, note: text(req.body.note, 500), at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_dismissed', { details: { itemId: String(it._id) } });
  res.json({ item: serialize(it, req.user) });
}));

// The Accountant records the payment of an approved item.
router.post('/:id/pay', wrap(async (req, res) => {
  if (!isAccountant(req.user)) throw new HttpError(403, 'Only the Accountant records payments.');
  const it = await load(req.params.id, req.user);
  if (it.status !== 'approved') throw new HttpError(409, 'Only an approved item, not yet paid, can be paid.');
  const pvNo = text(req.body.pvNo, 60);
  if (!pvNo) throw new HttpError(400, 'Enter the payment voucher number.');
  const date = DAY.test(req.body.date || '') ? req.body.date : new Date().toISOString().slice(0, 10);
  const amount = req.body.amount === undefined || req.body.amount === '' ? it.decision.amount : Math.round(Number(req.body.amount) * 100) / 100;
  if (!(amount > 0) || amount > it.decision.amount) throw new HttpError(400, `The amount paid must be more than nothing and not more than the ${money(it.decision.amount)} approved.`);
  it.payment = { pvNo, date, amount, byName: req.user.fullName, at: new Date() };
  it.status = 'paid';
  it.history.push({ action: 'paid', byName: req.user.fullName, note: `${money(amount)}, PV ${pvNo}`, at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_paid', { details: { itemId: String(it._id), pvNo, amount } });
  const msg = `Paid: ${it.item}, ${money(amount)} (PV ${pvNo}).`;
  await tell([...await holders('chief_judge'), ...await requester(it)], msg, 'Cash flow: paid');
  res.json({ item: serialize(it, req.user) });
}));

router.get('/:id/files/:i', wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  const a = it.attachments[Number(req.params.i)];
  if (!a) throw new HttpError(404, 'Attachment not found.');
  const f = await fileStore.read(a.file);
  if (!f) throw new HttpError(404, 'The file is missing.');
  res.set('Content-Type', f.contentType).set('Content-Disposition', `inline; filename="${String(a.name || 'attachment').replace(/"/g, '')}"`).set('Cache-Control', 'private, no-store').send(f.buffer);
}));

router.get('/:id/signature', wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  if (!it.decision || !it.decision.image) throw new HttpError(404, 'Not approved.');
  const img = await store.read(it.decision.image);
  if (!img) throw new HttpError(404, 'Signature image missing.');
  res.set('Content-Type', img.contentType).set('Cache-Control', 'private, max-age=86400').send(img.buffer);
}));

// ── The printed approved cash flow, with its QR code ──
// What is printed is fixed under a verification code; printed again
// unchanged, the same code. The public check confirms it and its total.
const sheetHash = (month, items, total) => crypto.createHash('sha256').update(JSON.stringify({ month, items: items.map(i => [i.sn, i.item, i.amount, i.approved, i.approvedBy, new Date(i.approvedAt).toISOString(), !!i.paid, i.pvNo || '']), total })).digest('hex');
router.post('/sheet', wrap(async (req, res) => {
  if (!seesAll(req.user)) throw new HttpError(403, 'You do not have access to the cash flow.');
  const month = cf.MONTH.test(req.body.month || '') ? req.body.month : cf.thisMonth();
  const list = await CashItem.find({ month, status: { $in: ['approved', 'paid'] } }).sort({ sn: 1 });
  if (!list.length) throw new HttpError(409, 'Nothing approved on this cash flow yet.');
  const items = list.map(x => ({ sn: x.sn, item: x.item, requestedByName: x.requestedByName, amount: x.amount, approved: x.decision.amount,
    approvedBy: [x.decision.title, x.decision.byName].filter(Boolean).join(' '), approvedAt: x.decision.at, paid: x.status === 'paid', pvNo: x.payment ? x.payment.pvNo : '' }));
  const total = Math.round(items.reduce((n, i) => n + i.approved, 0) * 100) / 100;
  const hash = sheetHash(month, items, total);
  let sheet = await CashSheet.findOne({ month, contentHash: hash });
  if (!sheet) {
    let code;
    for (let i = 0; i < 5; i++) { code = verification.newCode(); if (!(await CashSheet.exists({ verifyCode: code }))) break; }
    sheet = await CashSheet.create({ month, verifyCode: code, items, total, contentHash: hash, printedByName: req.user.fullName, printedAt: new Date() });
    await audit.log(req, 'cashflow_sheet_printed', { details: { month, verifyCode: code, total, items: items.length } });
  }
  const url = `${verification.baseUrl(req)}/verify/${sheet.verifyCode}`;
  res.json({ verifyCode: sheet.verifyCode, verifyUrl: url, qrDataUrl: await verification.qrDataUrl(url), printedAt: sheet.printedAt, total });
}));
// The public check (from verify.js): what a code confirms, or null.
async function verifySheet(code) {
  const sh = await CashSheet.findOne({ verifyCode: code });
  if (!sh) return null;
  const items = sh.items.map(i => (i.toObject ? i.toObject() : i));
  const intact = sheetHash(sh.month, items, sh.total) === sh.contentHash;
  const approvers = [...new Map(items.map(i => [i.approvedBy, i])).values()];
  return {
    status: intact ? 'valid' : 'tampered', code: sh.verifyCode,
    document: `Approved Cash Flow: ${cf.monthName(sh.month)}`,
    reference: `${items.length} item(s), total approved ${money(sh.total)}`,
    court: 'Office of the Hon. Chief Judge, Gombe State High Court of Justice',
    issuedAt: sh.printedAt,
    signedBy: approvers.map(i => ({ capacity: 'Hon. Chief Judge', name: i.approvedBy, title: null, signedAt: i.approvedAt }))
  };
}

// Settings: the amount released each month (the administrator).
router.get('/admin/releases', wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Only an administrator sets the amounts released.');
  const r = await cf.releases();
  res.json({ releases: Object.entries(r).sort((a, b) => b[0].localeCompare(a[0])).map(([month, amount]) => ({ month, name: cf.monthName(month), amount })), thisMonth: cf.thisMonth() });
}));
router.put('/admin/releases', wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Only an administrator sets the amounts released.');
  try { await cf.setRelease(String(req.body.month || ''), req.body.amount, req.user.fullName); } catch (e) { throw new HttpError(e.status || 500, e.message); }
  await audit.log(req, 'cashflow_release_set', { details: { month: req.body.month, amount: Number(req.body.amount) } });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.verifySheet = verifySheet;

/*
 * src/routes/cashflow.js — the monthly cash flow.
 *
 *   1. The CJ's aide, the Chief Registrar or the DCR Admin and Finance
 *      requests an item; it goes to the DCR Admin and Finance.
 *   2. The DCR reviews it (may correct it, or return it to the requester
 *      with a query), enters who is to be paid (beneficiaries, bank,
 *      account number, amount: the request for the release of funds), and
 *      submits it to the Hon. Chief Judge: the month's cash flow at once,
 *      selected items, or a supplementary submission.
 *   3. The Chief Judge approves it with the signing PIN (all of it, part of
 *      its lines, or a lower amount; several at once if he chooses), and so
 *      approves the release of its funds: the beneficiaries' amounts are
 *      scaled to what he approved. Or he declines it, or returns it to the
 *      DCR with a query.
 *   4. The DCR transmits the approved item to the Chief Registrar: all of
 *      it, or in instalments when it is paid in parts.
 *   5. The Chief Registrar sends each to the Chief Accountant (no change:
 *      the Chief Judge has approved it).
 *   6. The Chief Accountant pays each beneficiary at the approved amount and
 *      records the PV.
 *   An item not approved is carried to the next cash flow or dismissed.
 *
 * Who sees what: the Chief Judge, the CJ's aide, the Chief Registrar and
 * the DCR Admin and Finance see every item; the Chief Accountant, the
 * approved ones. The money (overhead received, balance): the Chief Judge,
 * the Chief Registrar (who enters the overhead each month) and the
 * administrator.
 */
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { CashItem, CashSheet, CashSubmission, CashMandatory, User, Notification } = require('../models');
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
const isDCR = (u) => has(u, ['dcr_admin_finance']);
const isCR = (u) => has(u, ['chief_registrar']);
// The administrator sees everything (the money too), to oversee; acting is for the officers.
const seesAll = (u) => isCJ(u) || isRequester(u) || isAdmin(u);
// The money: the Chief Judge, the administrator, and the Chief Registrar,
// who enters the overhead received from the government each month.
const seesMoney = (u) => isCJ(u) || isAdmin(u) || isCR(u);
const setsOverhead = (u) => isAdmin(u) || isCR(u);
const mine = (u, it) => String(it.requestedBy) === String(u._id);
const roleOf = (u) => ['cj_aide', 'chief_registrar', 'dcr_admin_finance'].find(r => u.signerRoles.includes(r)) || '';
const ROLE_NAME = { cj_aide: 'Aide to the Hon. Chief Judge', chief_registrar: 'Chief Registrar', dcr_admin_finance: 'DCR Admin and Finance' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const round = cf.round;

function mustUse(u) {
  if (!seesAll(u) && !isAccountant(u)) throw new HttpError(403, 'The cash flow is for the Hon. Chief Judge, the CJ\'s aide, the Chief Registrar, the DCR Admin and Finance and the Chief Accountant.');
}
async function load(id, u) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Item not found.');
  await cf.migrate();
  const it = await CashItem.findById(id);
  if (!it) throw new HttpError(404, 'Item not found.');
  if (!it.sections.length) { it.sections = cf.oneLine(it); await it.save(); }
  if (!seesAll(u) && !(isAccountant(u) && ['approved', 'paid'].includes(it.status))) throw new HttpError(403, 'You do not have access to this item.');
  return it;
}

// ── The money of an item: beneficiaries, what was approved, transmitted and paid ──
const approvedOf = (it) => it.decision && it.decision.kind === 'approved' ? it.decision.amount : 0;
const payeesTotal = (it) => round((it.payees || []).reduce((n, p) => n + (p.amount || 0), 0));
const ready = (it) => (it.payees || []).length > 0 && Math.abs(payeesTotal(it) - it.amount) < 0.005;
// What is already transmitted to each beneficiary (by payee id).
function transmittedBy(it) {
  const out = {};
  (it.tranches || []).forEach(t => t.payees.forEach(p => { const k = String(p.payee); out[k] = round((out[k] || 0) + (p.paid ? p.paid.amount : p.amount)); }));
  return out;
}
const leftToTransmit = (it) => { const t = transmittedBy(it); return round((it.payees || []).reduce((n, p) => n + Math.max(0, (p.approved || 0) - (t[String(p._id)] || 0)), 0)); };
// An instalment still with the Chief Registrar, or a beneficiary still to be paid.
const openTranche = (it) => (it.tranches || []).some(t => !t.sent || t.payees.some(p => !p.paid));
// The beneficiaries scaled to what the CJ approved, so they add up to it.
function scalePayees(it, approved) {
  const total = payeesTotal(it);
  if (!(total > 0)) return;
  const ratio = approved / total;
  it.payees.forEach(p => { p.approved = round(p.amount * ratio); });
  const diff = round(approved - it.payees.reduce((n, p) => n + p.approved, 0));
  if (diff) { const big = it.payees.reduce((a, b) => (b.amount > a.amount ? b : a)); big.approved = round(big.approved + diff); }
  it.markModified('payees');
}
// What the CJ approved, fixed: payment is refused if it no longer matches.
const itemHash = (it) => crypto.createHash('sha256').update(JSON.stringify({ id: String(it._id), approved: approvedOf(it),
  payees: (it.payees || []).map(p => [String(p._id), p.name, p.bank, p.accountNo, p.accountName, p.approved]),
  by: it.decision && it.decision.byName, at: it.decision && new Date(it.decision.at).toISOString() })).digest('hex');

function serialize(it, u) {
  const o = it.toObject ? it.toObject() : it;
  const cj = isCJ(u), dcr = isDCR(u);
  const paid = cf.paidOf(o);
  const sent = transmittedBy(o);
  const left = o.status === 'approved' ? leftToTransmit(o) : 0;
  return {
    id: String(o._id), month: o.month, monthName: cf.monthName(o.month), sn: o.sn, item: o.item, description: o.description,
    sections: ((o.sections && o.sections.length) ? o.sections : cf.oneLine(o)).map(sec => ({ title: sec.title, subtotal: cf.subtotal(sec), approvedSubtotal: cf.subtotal(sec, true),
      lines: sec.lines.map(l => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, struck: !!l.struck })) })),
    amount: o.amount, department: o.department, justification: o.justification,
    attachments: (o.attachments || []).map((a, i) => ({ name: a.name, url: `/api/cashflow/${o._id}/files/${i}` })),
    status: o.status, requestedBy: String(o.requestedBy), requestedByName: o.requestedByName, requestedByRole: ROLE_NAME[o.requestedByRole] || '',
    query: o.query, carriedFrom: o.carriedFrom ? cf.monthName(o.carriedFrom) : '', requesterDecides: !!o.requesterDecides,
    decision: o.decision ? { kind: o.decision.kind, amount: o.decision.amount, note: o.decision.note, byName: o.decision.byName, title: o.decision.title, at: o.decision.at,
      signatureUrl: o.decision.image ? `/api/cashflow/${o._id}/signature` : null } : null,
    payees: (o.payees || []).map(p => ({ id: String(p._id), name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName, amount: p.amount, approved: p.approved,
      transmitted: sent[String(p._id)] || 0, paid: round((o.payments || []).filter(x => String(x.payeeId) === String(p._id)).reduce((n, x) => n + x.amount, 0)) })),
    payeesTotal: payeesTotal(o), ready: ready(o),
    submission: o.submission ? { id: String(o.submission.id), refNo: o.submission.refNo, byName: o.submission.byName, at: o.submission.at } : null,
    tranches: (o.tranches || []).map(t => ({ id: String(t._id), no: t.no, amount: t.amount, byName: t.byName, note: t.note, at: t.at, sent: t.sent,
      payees: t.payees.map(p => ({ id: String(p._id), name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName, amount: p.amount, paid: p.paid })) })),
    payments: o.payments || [], paid, leftToTransmit: left,
    history: [...(o.history || [])].reverse(), createdAt: o.createdAt,
    can: {
      prepare: dcr && o.status === 'with_dcr',
      returnToRequester: dcr && o.status === 'with_dcr' && !mine(u, o),
      submit: dcr && o.status === 'with_dcr' && ready(o),
      decide: cj && o.status === 'pending',
      answer: mine(u, o) && o.status === 'returned',
      carry: o.status === 'declined' && (cj || (mine(u, o) && o.requesterDecides)),
      transmit: dcr && o.status === 'approved' && left > 0.004,
      send: isCR(u) && (o.tranches || []).some(t => !t.sent),
      pay: isAccountant(u) && o.status === 'approved' && (o.tranches || []).some(t => t.sent && t.payees.some(p => !p.paid)),
      // Approved, part paid, and nothing more to come: closed as paid.
      complete: (cj || dcr) && o.status === 'approved' && paid > 0 && !openTranche(o)
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
// The item's fields; the total is worked out from its lines.
function cleanFields(b) {
  const item = text(b.item, 200);
  if (!item) throw new HttpError(400, 'Enter the item requested.');
  let lines;
  try { lines = cf.cleanSections(b.sections); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  return { item, description: text(b.description, 3000), ...lines, quantity: null, unitPrice: null,
    department: text(b.department, 200), justification: text(b.justification, 3000) };
}

// The beneficiaries entered by the DCR (each with a ten digit account number).
function cleanPayees(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch (e) { list = null; } }
  if (!Array.isArray(list)) return null;
  if (list.length > 100) throw new HttpError(400, 'Up to 100 beneficiaries for an item.');
  return list.map((p, j) => {
    const where = `beneficiary ${j + 1}`;
    const name = text(p && p.name, 150), bank = text(p && p.bank, 100), accountNo = String((p && p.accountNo) || '').replace(/\s/g, '');
    const amount = round(Number(p && p.amount));
    if (!name) throw new HttpError(400, `Enter the name of ${where}.`);
    if (!bank) throw new HttpError(400, `Enter the bank of ${where}.`);
    if (!/^\d{10}$/.test(accountNo)) throw new HttpError(400, `The account number of ${where} must be 10 digits.`);
    if (!(amount > 0)) throw new HttpError(400, `Enter the amount for ${where}.`);
    return { name, bank, accountNo, accountName: text(p && p.accountName, 150) || name, amount, approved: null };
  });
}
const meta = () => mongoose.connection.collection('appmeta');
async function nextSubmissionRef() {
  const year = new Date().getFullYear();
  const r = await meta().findOneAndUpdate({ _id: `cashSubSeq:${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `GSHC/CF/SUB/${year}/${String((r && r.value ? r.value : r).seq).padStart(4, '0')}`;
}
const idsOf = (raw, max) => {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(String))].filter(i => mongoose.isValidObjectId(i));
  if (ids.length > max) throw new HttpError(400, `Up to ${max} items at a time.`);
  return ids;
};
const list = (its) => its.map(it => `${it.item} (${money(approvedOf(it) || it.amount)})`).join('; ');

// ── Who I am here, and the month ──
router.get('/me', wrap(async (req, res) => {
  await cf.rollOver();
  const u = req.user;
  res.json({ month: cf.thisMonth(), monthName: cf.monthName(cf.thisMonth()), cj: isCJ(u), seesMoney: seesMoney(u), requester: isRequester(u),
    accountant: isAccountant(u), seesAll: seesAll(u), admin: isAdmin(u), setsOverhead: setsOverhead(u), dcr: isDCR(u), cr: isCR(u),
    mandatories: isCJ(u) || isCR(u) || isDCR(u) || isAccountant(u) || isAdmin(u) });
}));

// Waiting for this person.
router.get('/counts', wrap(async (req, res) => {
  const u = req.user;
  let n = 0;
  if (isCJ(u)) n += await CashItem.countDocuments({ status: 'pending' }) + await CashMandatory.countDocuments({ status: 'pending' });
  if (isDCR(u)) {
    n += await CashItem.countDocuments({ status: 'with_dcr' });
    n += (await CashItem.find({ status: 'approved' })).filter(it => leftToTransmit(it) > 0.004).length;
  }
  if (isCR(u)) {
    n += await CashItem.aggregate([{ $unwind: '$tranches' }, { $match: { 'tranches.sent': null } }, { $count: 'n' }]).then(r => (r[0] && r[0].n) || 0);
    n += await CashMandatory.countDocuments({ $or: [{ status: 'with_cr' }, { status: 'approved', transmitted: null }] });
  }
  if (isAccountant(u)) {
    n += await CashItem.aggregate([{ $unwind: '$tranches' }, { $match: { 'tranches.sent': { $ne: null } } }, { $unwind: '$tranches.payees' }, { $match: { 'tranches.payees.paid': null } }, { $count: 'n' }]).then(r => (r[0] && r[0].n) || 0);
    n += await CashMandatory.countDocuments({ preparedBy: u._id, status: 'returned' });
    n += await CashMandatory.aggregate([{ $match: { status: 'approved', transmitted: { $ne: null } } }, { $unwind: '$items' }, { $match: { 'items.struck': false } },
      { $unwind: '$items.payees' }, { $match: { 'items.payees.paid': null } }, { $count: 'n' }]).then(r => (r[0] && r[0].n) || 0);
  }
  if (isRequester(u)) n += await CashItem.countDocuments({ requestedBy: u._id, status: 'returned' });
  res.json({ waiting: n });
}));

// A month's cash flow (the money only for those who see it).
router.get('/', wrap(async (req, res) => {
  mustUse(req.user);
  await cf.rollOver();
  const month = cf.MONTH.test(req.query.month || '') ? req.query.month : cf.thisMonth();
  const q = { month, status: { $ne: 'dismissed' } };
  if (!seesAll(req.user)) q.status = { $in: ['approved', 'paid'] };
  const items = await CashItem.find(q).sort({ sn: 1 });
  const months = (await CashItem.distinct('month')).concat(Object.keys(await cf.releases()), [cf.thisMonth()]);
  res.json({ month, monthName: cf.monthName(month), items: items.map(x => serialize(x, req.user)),
    months: [...new Set(months)].sort().reverse().map(m => ({ month: m, name: cf.monthName(m) })),
    summary: seesMoney(req.user) ? await cf.summary(month) : null });
}));

// The work waiting at each desk, every month: the DCR's (to submit, to
// transmit), the Chief Registrar's (to send), the Chief Accountant's (to pay).
router.get('/desk', wrap(async (req, res) => {
  const u = req.user;
  mustUse(u);
  await cf.rollOver();
  const out = {};
  if (isDCR(u)) {
    out.toSubmit = (await CashItem.find({ status: { $in: ['with_dcr', 'returned'] } }).sort({ month: 1, sn: 1 })).map(x => serialize(x, u));
    out.toTransmit = (await CashItem.find({ status: 'approved' }).sort({ month: 1, sn: 1 })).filter(it => leftToTransmit(it) > 0.004).map(x => serialize(x, u));
  }
  if (isCR(u)) out.toSend = (await CashItem.find({ 'tranches.sent': null, 'tranches.0': { $exists: true } }).sort({ month: 1, sn: 1 })).map(x => serialize(x, u)).filter(x => x.tranches.some(t => !t.sent));
  if (isAccountant(u) || seesAll(u)) out.payments = (await CashItem.find({ tranches: { $elemMatch: { sent: { $ne: null } } } }).sort({ updatedAt: -1 }).limit(300)).map(x => serialize(x, u));
  res.json(out);
}));

// A requester's own items, every month.
router.get('/mine', wrap(async (req, res) => {
  if (!isRequester(req.user)) throw new HttpError(403, 'For those who request items on the cash flow.');
  const items = await CashItem.find({ requestedBy: req.user._id }).sort({ createdAt: -1 }).limit(500);
  res.json({ items: items.map(x => serialize(x, req.user)) });
}));

// ── The DCR Admin and Finance submits items to the Hon. Chief Judge ──
// The month's cash flow, selected items, or a supplementary submission;
// each item with its beneficiaries adding up to its amount.
router.post('/submit', wrap(async (req, res) => {
  if (!isDCR(req.user)) throw new HttpError(403, 'Only the DCR Admin and Finance submits the cash flow to the Hon. Chief Judge.');
  const ids = idsOf(req.body.ids, 300);
  if (!ids.length) throw new HttpError(400, 'Select the items to submit.');
  const its = await CashItem.find({ _id: { $in: ids } }).sort({ month: 1, sn: 1 });
  if (its.length !== ids.length || its.some(it => it.status !== 'with_dcr')) throw new HttpError(409, 'Some of the items selected are no longer with you. Refresh the list.');
  const notReady = its.filter(it => !ready(it));
  if (notReady.length) throw new HttpError(400, `Enter the beneficiaries (adding up to the amount) of: ${notReady.map(it => it.item).join('; ')}.`);
  const month = its[its.length - 1].month;
  const supplementary = !!(await CashSubmission.exists({ month }));
  const at = new Date();
  const sub = await CashSubmission.create({ refNo: await nextSubmissionRef(), month, items: its.map(it => it._id), total: round(its.reduce((n, it) => n + it.amount, 0)),
    supplementary, note: text(req.body.note, 3000), by: req.user._id, byName: req.user.fullName });
  for (const it of its) {
    it.submission = { id: sub._id, refNo: sub.refNo, byName: req.user.fullName, at };
    it.status = 'pending';
    it.history.push({ action: 'submitted', byName: req.user.fullName, note: `To the Hon. Chief Judge, with the request for the release of funds (${sub.refNo}${supplementary ? ', supplementary' : ''})`, at });
    await it.save();
  }
  await audit.log(req, 'cashflow_submitted', { details: { submissionId: String(sub._id), refNo: sub.refNo, items: its.length, total: sub.total } });
  await tell(await holders('chief_judge', req.user._id), `${req.user.fullName} (DCR Admin and Finance) submitted ${its.length} cash flow item(s), ${money(sub.total)}, for your approval (${sub.refNo}${supplementary ? ', supplementary' : ''}).`, 'Cash flow: for your approval');
  res.status(201).json({ submission: { id: String(sub._id), refNo: sub.refNo, supplementary, items: its.length, total: sub.total } });
}));

// A submission, for its printed memo.
router.get('/submissions/:sid', wrap(async (req, res) => {
  mustUse(req.user);
  if (!mongoose.isValidObjectId(req.params.sid)) throw new HttpError(404, 'Submission not found.');
  const sub = await CashSubmission.findById(req.params.sid);
  if (!sub) throw new HttpError(404, 'Submission not found.');
  const its = await CashItem.find({ _id: { $in: sub.items } }).sort({ month: 1, sn: 1 });
  res.json({ submission: { id: String(sub._id), refNo: sub.refNo, month: sub.month, monthName: cf.monthName(sub.month), supplementary: sub.supplementary,
    note: sub.note, byName: sub.byName, at: sub.createdAt, total: sub.total }, items: its.map(x => serialize(x, req.user)) });
}));

// The Hon. Chief Judge approves several items at once, each in full, with one PIN.
router.post('/decide-many', wrap(async (req, res) => {
  if (!isCJ(req.user)) throw new HttpError(403, 'Only the Hon. Chief Judge decides on the cash flow.');
  const ids = idsOf(req.body.ids, 300);
  if (!ids.length) throw new HttpError(400, 'Select the items to approve.');
  const its = await CashItem.find({ _id: { $in: ids } });
  if (its.length !== ids.length || its.some(it => it.status !== 'pending')) throw new HttpError(409, 'Some of the items selected are no longer waiting for a decision. Refresh the list.');
  const me = req.user;
  if (!me.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
  await verifyPin(me, req.body.pin);
  const note = text(req.body.note, 2000);
  const at = new Date();
  for (const it of its) {
    it.sections.forEach(sec => sec.lines.forEach(l => { l.struck = false; }));
    it.markModified('sections');
    it.decision = { kind: 'approved', amount: it.amount, note, by: me._id, byName: me.fullName, title: me.title, at, image: me.signature };
    scalePayees(it, it.amount);
    it.contentHash = itemHash(it);
    it.status = 'approved';
    it.history.push({ action: 'approved', byName: me.fullName, note: [`${money(it.amount)}, with the release of funds`, note && note.replace(/[.\s]+$/, '')].filter(Boolean).join('. '), at });
    await it.save();
    await audit.log(req, 'cashflow_approved', { details: { itemId: String(it._id), item: it.item, amount: it.amount, note, together: its.length } });
  }
  await afterApproval(its);
  res.json({ approved: its.length, total: round(its.reduce((n, it) => n + it.amount, 0)) });
}));
async function afterApproval(its) {
  const byRequester = new Map();
  its.forEach(it => { const k = String(it.requestedBy); byRequester.set(k, [...(byRequester.get(k) || []), it]); });
  for (const [uid, group] of byRequester) await tell(await User.find({ _id: uid, active: true }), `The Hon. Chief Judge approved ${list(group)}.`, 'Cash flow: approved');
  await tell(await holders('dcr_admin_finance'), `Approved by the Hon. Chief Judge, with the release of funds: ${list(its)}. Transmit to the Chief Registrar for payment.`, 'Cash flow: approved, to transmit');
}

// ── The DCR transmits approved items to the Chief Registrar ──
// Each item in full (what is left), or, for one item, an instalment: the
// amount for each beneficiary this time.
router.post('/transmit', wrap(async (req, res) => {
  if (!isDCR(req.user)) throw new HttpError(403, 'Only the DCR Admin and Finance transmits approved items to the Chief Registrar.');
  const wanted = Array.isArray(req.body.items) ? req.body.items : [];
  if (!wanted.length) throw new HttpError(400, 'Select the items to transmit.');
  if (wanted.length > 300) throw new HttpError(400, 'Up to 300 items at a time.');
  const note = text(req.body.note, 1000);
  const done = [];
  for (const w of wanted) {
    if (!mongoose.isValidObjectId(w && w.id)) throw new HttpError(404, 'Item not found.');
    const it = await CashItem.findById(w.id);
    if (!it || it.status !== 'approved') throw new HttpError(409, `${it ? it.item : 'An item'} is not an approved item waiting to be transmitted.`);
    if (it.contentHash && itemHash(it) !== it.contentHash) throw new HttpError(409, `${it.item} no longer matches what the Hon. Chief Judge approved. Contact the administrator.`);
    const sent = transmittedBy(it);
    const parts = Array.isArray(w.payees) ? Object.fromEntries(w.payees.map(p => [String(p.id), round(Number(p.amount))])) : null;
    const lines = it.payees.map(p => {
      const left = round((p.approved || 0) - (sent[String(p._id)] || 0));
      const amount = parts ? (parts[String(p._id)] || 0) : left;
      if (amount < 0 || amount > left + 0.004) throw new HttpError(400, `${it.item}: ${p.name} has ${money(left)} left to transmit.`);
      return { payee: p._id, name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName, amount, paid: null };
    }).filter(l => l.amount > 0);
    if (!lines.length) throw new HttpError(400, `${it.item}: nothing to transmit.`);
    const amount = round(lines.reduce((n, l) => n + l.amount, 0));
    const no = (it.tranches || []).length + 1;
    const whole = !parts || Math.abs(amount - leftToTransmit(it)) < 0.005;
    it.tranches.push({ no, amount, byName: req.user.fullName, note, at: new Date(), sent: null, payees: lines });
    it.history.push({ action: 'transmitted', byName: req.user.fullName, note: [`${money(amount)} to the Chief Registrar${whole && no === 1 ? '' : `, instalment ${no}`}`, note].filter(Boolean).join('. '), at: new Date() });
    await it.save();
    await audit.log(req, 'cashflow_transmitted', { details: { itemId: String(it._id), tranche: no, amount } });
    done.push({ it, amount });
  }
  await tell(await holders('chief_registrar', req.user._id), `${req.user.fullName} (DCR Admin and Finance) transmitted for payment: ${done.map(d => `${d.it.item} (${money(d.amount)})`).join('; ')}. Send to the Chief Accountant.`, 'Cash flow: to send for payment');
  res.json({ transmitted: done.length, total: round(done.reduce((n, d) => n + d.amount, 0)) });
}));

// ── The Chief Registrar sends transmitted items to the Chief Accountant ──
router.post('/send', wrap(async (req, res) => {
  if (!isCR(req.user)) throw new HttpError(403, 'Only the Chief Registrar sends items to the Chief Accountant.');
  const ids = idsOf(req.body.ids, 300);
  if (!ids.length) throw new HttpError(400, 'Select the items to send.');
  const its = await CashItem.find({ _id: { $in: ids } });
  if (its.length !== ids.length || its.some(it => !(it.tranches || []).some(t => !t.sent))) throw new HttpError(409, 'Some of the items selected have nothing waiting to be sent. Refresh the list.');
  const note = text(req.body.note, 1000);
  const at = new Date();
  const done = [];
  for (const it of its) {
    let amount = 0;
    it.tranches.filter(t => !t.sent).forEach(t => { t.sent = { byName: req.user.fullName, note, at }; amount += t.amount; });
    it.history.push({ action: 'sent', byName: req.user.fullName, note: [`${money(amount)} to the Chief Accountant for payment`, note].filter(Boolean).join('. '), at });
    it.markModified('tranches');
    await it.save();
    await audit.log(req, 'cashflow_sent', { details: { itemId: String(it._id), amount } });
    done.push({ it, amount: round(amount) });
  }
  await tell(await holders('accountant'), `For payment, sent by the Chief Registrar: ${done.map(d => `${d.it.item} (${money(d.amount)})`).join('; ')}.${note ? ` ${note}` : ''}`, 'Cash flow: for payment');
  res.json({ sent: done.length, total: round(done.reduce((n, d) => n + d.amount, 0)) });
}));

router.get('/:id', wrap(async (req, res) => {
  res.json({ item: serialize(await load(req.params.id, req.user), req.user) });
}));

// A new request: onto this month's cash flow, to the DCR Admin and Finance.
router.post('/', files, wrap(async (req, res) => {
  if (!isRequester(req.user)) throw new HttpError(403, 'Only the CJ\'s aide, the Chief Registrar and the DCR Admin and Finance request items on the cash flow.');
  await cf.rollOver();
  const fields = cleanFields(req.body || {});
  const month = cf.thisMonth();
  const it = await CashItem.create({ ...fields, month, sn: await cf.nextSn(month), attachments: await saveFiles(req), status: 'with_dcr',
    requestedBy: req.user._id, requestedByName: req.user.fullName, requestedByRole: roleOf(req.user),
    history: [{ action: 'requested', byName: req.user.fullName, note: `${money(fields.amount)}, to the DCR Admin and Finance`, at: new Date() }] });
  await audit.log(req, 'cashflow_requested', { details: { itemId: String(it._id), month, item: it.item, amount: it.amount } });
  await tell(await holders('dcr_admin_finance', req.user._id), `${req.user.fullName} (${ROLE_NAME[roleOf(req.user)]}) requested ${it.item}, ${money(it.amount)}, on the ${cf.monthName(month)} cash flow. Enter the beneficiaries and submit it to the Hon. Chief Judge.`, 'Cash flow: new request');
  res.status(201).json({ item: serialize(it, req.user) });
}));

// The requester answers the DCR's query (and may correct the item); it goes back to the DCR.
router.put('/:id', files, wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  if (!mine(req.user, it) || it.status !== 'returned') throw new HttpError(409, 'Only an item returned to you with a query can be changed and sent back.');
  const answer = text(req.body.answer, 2000);
  if (!answer) throw new HttpError(400, 'Answer the query.');
  Object.assign(it, cleanFields({ ...it.toObject(), ...req.body }));
  it.attachments.push(...await saveFiles(req));
  it.status = 'with_dcr';
  it.history.push({ action: 'answered', byName: req.user.fullName, note: answer, at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_answered', { details: { itemId: String(it._id), answer } });
  await tell(await holders('dcr_admin_finance', req.user._id), `${req.user.fullName} answered your query on ${it.item} (${money(it.amount)}): ${answer}`, 'Cash flow: query answered');
  res.json({ item: serialize(it, req.user) });
}));

// The DCR prepares an item: corrects it if need be, and enters its beneficiaries.
router.put('/:id/prepare', files, wrap(async (req, res) => {
  if (!isDCR(req.user)) throw new HttpError(403, 'Only the DCR Admin and Finance prepares items for the Hon. Chief Judge.');
  const it = await load(req.params.id, req.user);
  if (it.status !== 'with_dcr') throw new HttpError(409, 'This item is not with you.');
  const before = it.amount;
  Object.assign(it, cleanFields({ ...it.toObject(), ...req.body }));
  const payees = cleanPayees(req.body.payees);
  if (payees) it.payees = payees;
  it.attachments.push(...await saveFiles(req));
  const changed = before !== it.amount;
  it.history.push({ action: 'prepared', byName: req.user.fullName, note: [changed ? `Amount changed from ${money(before)} to ${money(it.amount)}` : '',
    payees ? `${payees.length} beneficiar${payees.length === 1 ? 'y' : 'ies'}, ${money(payeesTotal(it))}` : ''].filter(Boolean).join('. '), at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_prepared', { details: { itemId: String(it._id), amount: it.amount, payees: it.payees.length } });
  res.json({ item: serialize(it, req.user) });
}));

// The DCR returns an item to its requester with a query.
router.post('/:id/return', wrap(async (req, res) => {
  if (!isDCR(req.user)) throw new HttpError(403, 'Only the DCR Admin and Finance returns items to their requesters.');
  const it = await load(req.params.id, req.user);
  if (it.status !== 'with_dcr') throw new HttpError(409, 'This item is not with you.');
  const note = text(req.body.note, 2000);
  if (!note) throw new HttpError(400, 'Write the query.');
  it.query = { text: note, byName: req.user.fullName, by: 'DCR Admin and Finance', at: new Date() };
  it.status = 'returned';
  it.history.push({ action: 'returned', byName: req.user.fullName, note, at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_returned', { details: { itemId: String(it._id), note } });
  await tell(await requester(it), `The DCR Admin and Finance returned ${it.item} (${money(it.amount)}) with a query: ${note}`, 'Cash flow: query');
  res.json({ item: serialize(it, req.user) });
}));

// The Chief Judge: approve (in full or less, with the PIN), decline, or return to the DCR with a query.
router.post('/:id/decide', wrap(async (req, res) => {
  if (!isCJ(req.user)) throw new HttpError(403, 'Only the Hon. Chief Judge decides on the cash flow.');
  const it = await load(req.params.id, req.user);
  if (it.status !== 'pending') throw new HttpError(409, 'This item is not waiting for a decision.');
  const action = String(req.body.action || '');
  const note = text(req.body.note, 2000);
  const me = req.user;
  if (action === 'approve') {
    // Part of an item: the lines struck out ("section.line") are not approved.
    const struck = new Set((Array.isArray(req.body.struck) ? req.body.struck : []).map(String));
    const out = [];
    it.sections.forEach((sec, i) => sec.lines.forEach((l, j) => { l.struck = struck.has(`${i}.${j}`); if (l.struck) out.push(l.description); }));
    const kept = it.sections.reduce((n, sec) => n + cf.subtotal(sec, true), 0);
    if (!(kept > 0)) throw new HttpError(400, 'Every line is struck out. Decline the item instead.');
    const amount = req.body.amount === undefined || req.body.amount === '' ? round(kept) : round(Number(req.body.amount));
    if (!(amount > 0)) throw new HttpError(400, 'Enter the amount approved.');
    if (amount > kept + 0.001) throw new HttpError(400, `The amount approved cannot be more than ${money(kept)}, the total of the lines approved.`);
    if (!me.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
    await verifyPin(me, req.body.pin);
    it.markModified('sections');
    const notOut = out.length ? `Not approved: ${out.slice(0, 10).join(', ')}${out.length > 10 ? ` and ${out.length - 10} more` : ''}` : '';
    it.decision = { kind: 'approved', amount, note, by: me._id, byName: me.fullName, title: me.title, at: new Date(), image: me.signature };
    // The beneficiaries follow: scaled to the amount approved.
    scalePayees(it, amount);
    it.contentHash = itemHash(it);
    it.status = 'approved';
    it.history.push({ action: 'approved', byName: me.fullName, note: [amount < it.amount ? `${money(amount)} of ${money(it.amount)}` : money(amount), 'with the release of funds', notOut, note && note.replace(/[.\s]+$/, '')].filter(Boolean).join('. '), at: new Date() });
  } else if (action === 'decline') {
    it.decision = { kind: 'declined', amount: 0, note, by: me._id, byName: me.fullName, title: me.title, at: new Date() };
    it.status = 'declined';
    it.requesterDecides = !!req.body.requesterDecides;
    it.history.push({ action: 'declined', byName: me.fullName, note: [note && note.replace(/[.\s]+$/, ''), it.requesterDecides ? 'The requester to carry it forward or dismiss it' : ''].filter(Boolean).join('. '), at: new Date() });
  } else if (action === 'return') {
    if (!note) throw new HttpError(400, 'Write the query.');
    it.query = { text: note, byName: me.fullName, by: 'Hon. Chief Judge', at: new Date() };
    it.status = 'with_dcr';
    it.history.push({ action: 'returned', byName: me.fullName, note: `To the DCR Admin and Finance. ${note}`, at: new Date() });
  } else throw new HttpError(400, 'Approve, decline or return with a query.');
  await it.save();
  await audit.log(req, `cashflow_${action === 'return' ? 'returned' : it.status}`, { details: { itemId: String(it._id), item: it.item, amount: it.decision ? it.decision.amount : undefined, note } });
  const what = `${it.item} (${money(it.amount)})`;
  if (it.status === 'approved') await afterApproval([it]);
  else if (it.status === 'declined') {
    await tell([...await requester(it), ...await holders('dcr_admin_finance')], `The Hon. Chief Judge did not approve ${what}${note ? `: ${note}` : ''}.${it.requesterDecides ? ' The requester may carry it to the next cash flow or dismiss it.' : ''}`, 'Cash flow: not approved');
  } else {
    await tell(await holders('dcr_admin_finance'), `The Hon. Chief Judge returned ${what} with a query: ${note}`, 'Cash flow: query');
  }
  res.json({ item: serialize(it, req.user) });
}));

// An item not approved: carried to the next cash flow (back to the DCR), or dismissed.
router.post('/:id/carry', wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  if (it.status !== 'declined' || !(isCJ(req.user) || (mine(req.user, it) && it.requesterDecides))) throw new HttpError(403, 'Only the Hon. Chief Judge (or the requester, if left to them) carries an item not approved.');
  const to = [cf.nextMonth(it.month), cf.thisMonth()].sort().pop();
  const from = it.month;
  Object.assign(it, { month: to, sn: await cf.nextSn(to), status: 'with_dcr', carriedFrom: from, requesterDecides: false, decision: null, submission: null });
  it.payees.forEach(p => { p.approved = null; });
  it.markModified('payees');
  it.history.push({ action: 'carried', byName: req.user.fullName, note: `Carried from ${cf.monthName(from)} to the ${cf.monthName(to)} cash flow, to the DCR Admin and Finance`, at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_carried', { details: { itemId: String(it._id), from, to } });
  await tell(await holders('dcr_admin_finance', req.user._id), `${it.item} was carried to the ${cf.monthName(to)} cash flow; submit it to the Hon. Chief Judge again when ready.`, 'Cash flow: carried forward');
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

// The Chief Accountant pays one beneficiary of a sent instalment: the amount approved, with the PV.
router.post('/:id/pay', wrap(async (req, res) => {
  if (!isAccountant(req.user)) throw new HttpError(403, 'Only the Chief Accountant records payments.');
  const it = await load(req.params.id, req.user);
  if (it.status !== 'approved') throw new HttpError(409, 'Only an approved item, not yet paid, can be paid.');
  let line = null, tranche = null;
  it.tranches.forEach(t => t.payees.forEach(p => { if (String(p._id) === String(req.body.line)) { line = p; tranche = t; } }));
  if (!line) throw new HttpError(404, 'Beneficiary not found.');
  if (!tranche.sent) throw new HttpError(409, 'The Chief Registrar has not yet sent this for payment.');
  if (line.paid) throw new HttpError(409, `${line.name} has been paid.`);
  if (it.contentHash && itemHash(it) !== it.contentHash) throw new HttpError(409, 'This item no longer matches what the Hon. Chief Judge approved. Contact the administrator.');
  const pvNo = text(req.body.pvNo, 60);
  if (!pvNo) throw new HttpError(400, 'Enter the payment voucher number.');
  const date = DAY.test(req.body.date || '') ? req.body.date : new Date().toISOString().slice(0, 10);
  const at = new Date();
  line.paid = { pvNo, date, amount: line.amount, byName: req.user.fullName, at };
  it.payments.push({ payee: line.name, payeeId: line.payee, bank: line.bank, accountNo: line.accountNo, pvNo, date, amount: line.amount, month: it.month, byName: req.user.fullName, at });
  it.history.push({ action: 'paid', byName: req.user.fullName, note: `${money(line.amount)} to ${line.name}, PV ${pvNo}`, at });
  if (cf.paidOf(it) >= approvedOf(it) - 0.004) it.status = 'paid';
  it.markModified('tranches');
  await it.save();
  await audit.log(req, 'cashflow_paid', { details: { itemId: String(it._id), pvNo, amount: line.amount, payee: line.name } });
  await tell([...await holders('chief_judge'), ...await holders('dcr_admin_finance'), ...await requester(it)], `Paid: ${money(line.amount)} to ${line.name} for ${it.item} (PV ${pvNo}).`, 'Cash flow: paid');
  res.json({ item: serialize(it, req.user) });
}));

// An approved item paid in part, with nothing more to come: closed as paid
// (the Hon. Chief Judge or the DCR Admin and Finance).
router.post('/:id/complete', wrap(async (req, res) => {
  const it = await load(req.params.id, req.user);
  if (!(isCJ(req.user) || isDCR(req.user))) throw new HttpError(403, 'Only the Hon. Chief Judge or the DCR Admin and Finance closes an item.');
  const paid = cf.paidOf(it);
  if (it.status !== 'approved' || !(paid > 0)) throw new HttpError(409, 'Only an approved item already paid in part can be closed.');
  if (openTranche(it)) throw new HttpError(409, 'An instalment of this item is still with the Chief Registrar or waiting to be paid.');
  it.status = 'paid';
  it.history.push({ action: 'completed', byName: req.user.fullName, note: [`Closed with ${money(paid)} paid of ${money(it.decision.amount)} approved`, text(req.body.note, 500)].filter(Boolean).join('. '), at: new Date() });
  await it.save();
  await audit.log(req, 'cashflow_completed', { details: { itemId: String(it._id), paid } });
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
// The beneficiaries (what each is to receive) are part of what is fixed.
const sheetHash = (month, items, total) => crypto.createHash('sha256').update(JSON.stringify({ month, items: items.map(i => [i.sn, i.item, i.amount, i.approved, i.approvedBy, new Date(i.approvedAt).toISOString(), !!i.paid, i.pvNo || '',
  ...((i.payees && i.payees.length) ? [(i.payees || []).map(p => [p.name, p.bank, p.accountNo, p.amount])] : [])]), total })).digest('hex');
router.post('/sheet', wrap(async (req, res) => {
  if (!seesAll(req.user)) throw new HttpError(403, 'You do not have access to the cash flow.');
  const month = cf.MONTH.test(req.body.month || '') ? req.body.month : cf.thisMonth();
  const list = await CashItem.find({ month, status: { $in: ['approved', 'paid'] } }).sort({ sn: 1 });
  if (!list.length) throw new HttpError(409, 'Nothing approved on this cash flow yet.');
  const items = list.map(x => ({ sn: x.sn, item: x.item, requestedByName: x.requestedByName, amount: x.amount, approved: x.decision.amount,
    approvedBy: [x.decision.title, x.decision.byName].filter(Boolean).join(' '), approvedAt: x.decision.at, paid: x.status === 'paid', pvNo: (x.payments || []).map(p => p.pvNo).join(', '),
    payees: (x.payees || []).map(p => ({ name: p.name, bank: p.bank, accountNo: p.accountNo, amount: p.approved })) }));
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
    signedBy: approvers.map(i => ({ capacity: 'Hon. Chief Judge', name: i.approvedBy, title: null, signedAt: i.approvedAt })),
    // Who is to be paid, the account numbers shown with only their last four digits.
    lines: items.flatMap(i => (i.payees || []).map(p => `${i.item}: ${p.name} · ${p.bank} · ******${String(p.accountNo || '').slice(-4)} · ${money(p.amount)}`))
  };
}

// Settings: the amount released each month (the administrator).
router.get('/admin/releases', wrap(async (req, res) => {
  if (!setsOverhead(req.user)) throw new HttpError(403, 'Only the Chief Registrar or an administrator enters the overhead received.');
  const r = await cf.releases();
  const by = await cf.releasesBy();
  res.json({ releases: Object.entries(r).sort((a, b) => b[0].localeCompare(a[0])).map(([month, amount]) => ({ month, name: cf.monthName(month), amount,
    byName: by[month] ? by[month].byName : '', at: by[month] ? by[month].at : null })), thisMonth: cf.thisMonth() });
}));
router.put('/admin/releases', wrap(async (req, res) => {
  if (!setsOverhead(req.user)) throw new HttpError(403, 'Only the Chief Registrar or an administrator enters the overhead received.');
  try { await cf.setRelease(String(req.body.month || ''), req.body.amount, req.user.fullName); } catch (e) { throw new HttpError(e.status || 500, e.message); }
  await audit.log(req, 'cashflow_release_set', { details: { month: req.body.month, amount: Number(req.body.amount) } });
  if (!isCJ(req.user)) await tell(await holders('chief_judge', req.user._id), `${req.user.fullName} entered the overhead received for ${cf.monthName(req.body.month)}: ${money(req.body.amount)}.`, 'Cash flow: overhead received');
  res.json({ ok: true });
}));

module.exports = router;
module.exports.verifySheet = verifySheet;
module.exports.helpers = { isCJ, isCR, isDCR, isAccountant, seesAll, tell, holders, money, text, DAY };

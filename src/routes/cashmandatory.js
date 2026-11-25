/*
 * src/routes/cashmandatory.js — the monthly mandatories.
 *
 *   The standing payments made every month (casual staff, subscriptions,
 *   allowances to heads of units and directors…), approved directly by the
 *   Hon. Chief Judge, not on the cash flow:
 *
 *   1. the Chief Accountant prepares the month's list (a copy of last
 *      month's, changed as needed): each mandatory with its beneficiaries,
 *      bank, account number and amount;
 *   2. the Chief Registrar approves it and sends it to the Chief Judge, or
 *      returns it with a query;
 *   3. the Chief Judge approves it with the signing PIN (all of it, or
 *      without some mandatories), or returns it with a query;
 *   4. the Chief Registrar transmits it to the Chief Accountant;
 *   5. the Chief Accountant pays each beneficiary and records the PV (the
 *      amount is what was approved).
 *
 * They are paid from the month's overhead, before the cash flow items.
 */
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { CashMandatory, User } = require('../models');
const cf = require('../services/cashflow');
const verification = require('../services/verification');
const store = require('../services/signatureStore');
const audit = require('../services/audit');
const { verifyPin } = require('./me');
const { HttpError, requireLogin, isAdmin } = require('../middleware/auth');
const { isCJ, isCR, isDCR, isAccountant, tell, holders, money, text, DAY } = require('./cashflow').helpers;

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const sees = (u) => isCJ(u) || isCR(u) || isDCR(u) || isAccountant(u) || isAdmin(u);
const meta = () => mongoose.connection.collection('appmeta');
async function nextRef() {
  const year = new Date().getFullYear();
  const r = await meta().findOneAndUpdate({ _id: `cashManSeq:${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `GSHC/CF/MAN/${year}/${String((r && r.value ? r.value : r).seq).padStart(4, '0')}`;
}

async function load(id, u) {
  if (!sees(u)) throw new HttpError(403, 'The mandatories are for the Hon. Chief Judge, the Chief Registrar, the DCR Admin and Finance and the Chief Accountant.');
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'List not found.');
  const m = await CashMandatory.findById(id);
  if (!m) throw new HttpError(404, 'List not found.');
  return m;
}

// What the Chief Judge approved, fixed: the printed list's QR code checks against it.
const listHash = (m) => crypto.createHash('sha256').update(JSON.stringify({ refNo: m.refNo, month: m.month, approvedTotal: m.approvedTotal,
  items: m.items.map(x => [x.title, x.amount, !!x.struck, x.payees.map(p => [p.name, p.bank, p.accountNo, p.accountName, p.amount])]),
  approvedBy: m.decision && m.decision.byName, approvedAt: m.decision && new Date(m.decision.at).toISOString() })).digest('hex');

const paidOf = (m) => cf.round(m.items.reduce((n, x) => n + x.payees.reduce((k, p) => k + (p.paid ? p.paid.amount : 0), 0), 0));

function serialize(m, u) {
  const o = m.toObject ? m.toObject() : m;
  const mine = String(o.preparedBy) === String(u._id);
  return {
    id: String(o._id), refNo: o.refNo, month: o.month, monthName: cf.monthName(o.month), status: o.status, total: o.total, approvedTotal: o.approvedTotal,
    note: o.note, paid: paidOf(o),
    items: o.items.map(x => ({ title: x.title, amount: x.amount, struck: !!x.struck,
      payees: x.payees.map(p => ({ id: String(p._id), name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName, amount: p.amount, paid: p.paid })) })),
    preparedByName: o.preparedByName, createdAt: o.createdAt, query: o.query, forwarded: o.forwarded,
    decision: o.decision ? { kind: o.decision.kind, note: o.decision.note, byName: o.decision.byName, title: o.decision.title, at: o.decision.at,
      signatureUrl: o.decision.image ? `/api/cashflow/mandatories/${o._id}/signature` : null } : null,
    transmitted: o.transmitted ? { byName: o.transmitted.byName, note: o.transmitted.note, at: o.transmitted.at } : null,
    history: [...(o.history || [])].reverse(),
    can: {
      answer: isAccountant(u) && mine && o.status === 'returned',
      forward: isCR(u) && o.status === 'with_cr',
      decide: isCJ(u) && o.status === 'pending',
      transmit: isCR(u) && o.status === 'approved' && !o.transmitted,
      pay: isAccountant(u) && o.status === 'approved' && !!o.transmitted
    }
  };
}

// The mandatories sent: each with a title and its beneficiaries (bank, ten
// digit account number, amount); the totals are worked out here.
function cleanItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new HttpError(400, 'Add at least one mandatory.');
  if (list.length > 100) throw new HttpError(400, 'A list can have up to 100 mandatories.');
  return list.map((x, i) => {
    const title = text(x && x.title, 200);
    if (!title) throw new HttpError(400, `Give mandatory ${i + 1} a title (for example, Casual staff).`);
    const payees = Array.isArray(x && x.payees) ? x.payees : [];
    if (!payees.length) throw new HttpError(400, `Add the beneficiaries of ${title}.`);
    if (payees.length > 500) throw new HttpError(400, `${title}: up to 500 beneficiaries.`);
    const clean = payees.map((p, j) => {
      const where = `${title}, beneficiary ${j + 1}`;
      const name = text(p && p.name, 150), bank = text(p && p.bank, 100), accountNo = String((p && p.accountNo) || '').replace(/\s/g, '');
      const amount = cf.round(Number(p && p.amount));
      if (!name) throw new HttpError(400, `Enter the name of ${where}.`);
      if (!bank) throw new HttpError(400, `Enter the bank of ${where}.`);
      if (!/^\d{10}$/.test(accountNo)) throw new HttpError(400, `The account number of ${where} must be 10 digits.`);
      if (!(amount > 0) || amount > 1e12) throw new HttpError(400, `Enter the amount for ${where}.`);
      return { name, bank, accountNo, accountName: text(p && p.accountName, 150) || name, amount, paid: null };
    });
    return { title, amount: cf.round(clean.reduce((n, p) => n + p.amount, 0)), struck: false, payees: clean };
  });
}
const totalOf = (items) => cf.round(items.reduce((n, x) => n + x.amount, 0));
const what = (m) => `the ${cf.monthName(m.month)} mandatories, ${m.refNo} (${money(m.status === 'approved' || m.status === 'paid' ? m.approvedTotal : m.total)})`;
const preparer = (m) => User.find({ _id: m.preparedBy, active: true });

// ── Lists ──
router.get('/', wrap(async (req, res) => {
  if (!sees(req.user)) throw new HttpError(403, 'The mandatories are for the Hon. Chief Judge, the Chief Registrar, the DCR Admin and Finance and the Chief Accountant.');
  const list = await CashMandatory.find({}).sort({ month: -1, createdAt: -1 }).limit(200);
  res.json({ lists: list.map(m => serialize(m, req.user)), prepares: isAccountant(req.user), month: cf.thisMonth() });
}));

// Last month's list, to start this month's from.
router.get('/template', wrap(async (req, res) => {
  if (!isAccountant(req.user)) throw new HttpError(403, 'The Chief Accountant prepares the mandatories.');
  const last = await CashMandatory.findOne({ status: { $in: ['approved', 'paid'] } }).sort({ month: -1, createdAt: -1 })
    || await CashMandatory.findOne({}).sort({ month: -1, createdAt: -1 });
  res.json({ from: last ? { refNo: last.refNo, monthName: cf.monthName(last.month) } : null,
    items: last ? last.items.filter(x => !x.struck).map(x => ({ title: x.title, payees: x.payees.map(p => ({ name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName === p.name ? '' : p.accountName, amount: p.amount })) })) : [] });
}));

router.get('/:id', wrap(async (req, res) => {
  res.json({ list: serialize(await load(req.params.id, req.user), req.user) });
}));

// The Chief Accountant submits the month's list to the Chief Registrar.
router.post('/', wrap(async (req, res) => {
  if (!isAccountant(req.user)) throw new HttpError(403, 'The Chief Accountant prepares the mandatories.');
  const month = cf.MONTH.test(req.body.month || '') ? req.body.month : cf.thisMonth();
  const items = cleanItems(req.body.items);
  const m = await CashMandatory.create({ refNo: await nextRef(), month, items, total: totalOf(items), note: text(req.body.note, 3000),
    preparedBy: req.user._id, preparedByName: req.user.fullName,
    history: [{ action: 'submitted', byName: req.user.fullName, note: `${money(totalOf(items))} to the Chief Registrar`, at: new Date() }] });
  await audit.log(req, 'mandatory_submitted', { details: { listId: String(m._id), refNo: m.refNo, month, total: m.total } });
  await tell(await holders('chief_registrar', req.user._id), `${req.user.fullName} (Chief Accountant) submitted ${what(m)} for your approval.`, 'Mandatories: for your approval');
  res.status(201).json({ list: serialize(m, req.user) });
}));

// The Chief Accountant answers a query (and may correct the list), and sends it back to the Chief Registrar.
router.put('/:id', wrap(async (req, res) => {
  const m = await load(req.params.id, req.user);
  if (!isAccountant(req.user) || String(m.preparedBy) !== String(req.user._id) || m.status !== 'returned') throw new HttpError(409, 'Only a list returned to you with a query can be changed and sent back.');
  const answer = text(req.body.answer, 2000);
  if (!answer) throw new HttpError(400, 'Answer the query.');
  const items = cleanItems(req.body.items);
  Object.assign(m, { items, total: totalOf(items), note: text(req.body.note, 3000), status: 'with_cr', forwarded: null });
  m.history.push({ action: 'answered', byName: req.user.fullName, note: answer, at: new Date() });
  await m.save();
  await audit.log(req, 'mandatory_answered', { details: { listId: String(m._id), answer } });
  await tell(await holders('chief_registrar', req.user._id), `${req.user.fullName} answered the query on ${what(m)}: ${answer}`, 'Mandatories: query answered');
  res.json({ list: serialize(m, req.user) });
}));

// The Chief Registrar approves the list and sends it to the Chief Judge.
router.post('/:id/forward', wrap(async (req, res) => {
  const m = await load(req.params.id, req.user);
  if (!isCR(req.user)) throw new HttpError(403, 'Only the Chief Registrar sends the mandatories to the Hon. Chief Judge.');
  if (m.status !== 'with_cr') throw new HttpError(409, 'This list is not waiting for the Chief Registrar.');
  const note = text(req.body.note, 1000);
  m.forwarded = { byName: req.user.fullName, note, at: new Date() };
  m.status = 'pending';
  m.history.push({ action: 'forwarded', byName: req.user.fullName, note: ['Approved and sent to the Hon. Chief Judge', note].filter(Boolean).join('. '), at: new Date() });
  await m.save();
  await audit.log(req, 'mandatory_forwarded', { details: { listId: String(m._id), note } });
  await tell(await holders('chief_judge', req.user._id), `The Chief Registrar sent ${what(m)} for your approval.`, 'Mandatories: for your approval');
  await tell(await preparer(m), `The Chief Registrar approved ${what(m)} and sent it to the Hon. Chief Judge.`, 'Mandatories: with the Hon. Chief Judge');
  res.json({ list: serialize(m, req.user) });
}));

// Returned with a query: by the Chief Registrar (before sending it on) or the Chief Judge.
router.post('/:id/return', wrap(async (req, res) => {
  const m = await load(req.params.id, req.user);
  const byCR = isCR(req.user) && m.status === 'with_cr', byCJ = isCJ(req.user) && m.status === 'pending';
  if (!byCR && !byCJ) throw new HttpError(409, 'This list is not waiting for you.');
  const note = text(req.body.note, 2000);
  if (!note) throw new HttpError(400, 'Write the query.');
  m.query = { text: note, byName: req.user.fullName, by: byCJ ? 'Hon. Chief Judge' : 'Chief Registrar', at: new Date() };
  m.status = 'returned';
  m.history.push({ action: 'returned', byName: req.user.fullName, note, at: new Date() });
  await m.save();
  await audit.log(req, 'mandatory_returned', { details: { listId: String(m._id), note } });
  await tell(await preparer(m), `The ${m.query.by} returned ${what(m)} with a query: ${note}`, 'Mandatories: query');
  if (byCJ) await tell(await holders('chief_registrar'), `The Hon. Chief Judge returned ${what(m)} to the Chief Accountant with a query: ${note}`, 'Mandatories: query');
  res.json({ list: serialize(m, req.user) });
}));

// The Hon. Chief Judge approves the list with the PIN; mandatories unticked are not approved.
router.post('/:id/approve', wrap(async (req, res) => {
  if (!isCJ(req.user)) throw new HttpError(403, 'Only the Hon. Chief Judge approves the mandatories.');
  const m = await load(req.params.id, req.user);
  if (m.status !== 'pending') throw new HttpError(409, 'This list is not waiting for your approval.');
  const struck = new Set((Array.isArray(req.body.struck) ? req.body.struck : []).map(Number));
  m.items.forEach((x, i) => { x.struck = struck.has(i); });
  const kept = cf.round(m.items.filter(x => !x.struck).reduce((n, x) => n + x.amount, 0));
  if (!(kept > 0)) throw new HttpError(400, 'Every mandatory is unticked. Return the list with a query instead.');
  const me = req.user;
  if (!me.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
  await verifyPin(me, req.body.pin);
  const note = text(req.body.note, 2000);
  m.decision = { kind: 'approved', note, by: me._id, byName: me.fullName, title: me.title, at: new Date(), image: me.signature };
  m.approvedTotal = kept;
  m.status = 'approved';
  let code;
  for (let i = 0; i < 5; i++) { code = verification.newCode(); if (!(await CashMandatory.exists({ verifyCode: code }))) break; }
  m.verifyCode = code;
  m.contentHash = listHash(m);
  const out = m.items.filter(x => x.struck).map(x => x.title);
  m.history.push({ action: 'approved', byName: me.fullName, note: [kept < m.total ? `${money(kept)} of ${money(m.total)}` : money(kept), out.length ? `Not approved: ${out.join(', ')}` : '', note].filter(Boolean).join('. '), at: new Date() });
  m.markModified('items');
  await m.save();
  await audit.log(req, 'mandatory_approved', { details: { listId: String(m._id), refNo: m.refNo, approvedTotal: kept } });
  await tell(await holders('chief_registrar'), `The Hon. Chief Judge approved ${what(m)}. Transmit it to the Chief Accountant for payment.`, 'Mandatories: to transmit');
  await tell(await preparer(m), `The Hon. Chief Judge approved ${what(m)}${out.length ? `, without: ${out.join(', ')}` : ''}.`, 'Mandatories: approved');
  res.json({ list: serialize(m, req.user) });
}));

// The Chief Registrar transmits the approved list to the Chief Accountant.
router.post('/:id/transmit', wrap(async (req, res) => {
  const m = await load(req.params.id, req.user);
  if (!isCR(req.user)) throw new HttpError(403, 'Only the Chief Registrar transmits the mandatories for payment.');
  if (m.status !== 'approved' || m.transmitted) throw new HttpError(409, 'This list is not an approved list waiting to be transmitted.');
  const note = text(req.body.note, 1000);
  m.transmitted = { by: req.user._id, byName: req.user.fullName, note, at: new Date() };
  m.history.push({ action: 'transmitted', byName: req.user.fullName, note: ['To the Chief Accountant for payment', note].filter(Boolean).join('. '), at: new Date() });
  await m.save();
  await audit.log(req, 'mandatory_transmitted', { details: { listId: String(m._id) } });
  await tell(await holders('accountant'), `For payment, transmitted by the Chief Registrar: ${what(m)}.${note ? ` ${note}` : ''}`, 'Mandatories: for payment');
  res.json({ list: serialize(m, req.user) });
}));

// The Chief Accountant pays one beneficiary: the amount approved, with the PV.
router.post('/:id/pay', wrap(async (req, res) => {
  if (!isAccountant(req.user)) throw new HttpError(403, 'Only the Chief Accountant records payments.');
  const m = await load(req.params.id, req.user);
  if (m.status !== 'approved') throw new HttpError(409, 'Only an approved list can be paid.');
  if (!m.transmitted) throw new HttpError(409, 'The Chief Registrar has not yet transmitted this list for payment.');
  let line = null, item = null;
  m.items.forEach(x => x.payees.forEach(p => { if (String(p._id) === String(req.body.payee)) { line = p; item = x; } }));
  if (!line) throw new HttpError(404, 'Beneficiary not found.');
  if (item.struck) throw new HttpError(409, `${item.title} was not approved by the Hon. Chief Judge.`);
  if (line.paid) throw new HttpError(409, `${line.name} has been paid.`);
  if (listHash(m) !== m.contentHash) throw new HttpError(409, 'This list no longer matches what the Hon. Chief Judge approved. Contact the administrator.');
  const pvNo = text(req.body.pvNo, 60);
  if (!pvNo) throw new HttpError(400, 'Enter the payment voucher number.');
  const date = DAY.test(req.body.date || '') ? req.body.date : new Date().toISOString().slice(0, 10);
  line.paid = { pvNo, date, amount: line.amount, byName: req.user.fullName, at: new Date() };
  if (m.items.filter(x => !x.struck).every(x => x.payees.every(p => p.paid))) {
    m.status = 'paid';
    m.history.push({ action: 'paid', byName: req.user.fullName, note: 'Every beneficiary paid', at: new Date() });
  }
  m.markModified('items');
  await m.save();
  await audit.log(req, 'mandatory_paid', { details: { listId: String(m._id), payee: line.name, pvNo, amount: line.amount } });
  if (m.status === 'paid') await tell([...await holders('chief_judge'), ...await holders('chief_registrar')], `Paid in full: ${what(m)}.`, 'Mandatories: paid');
  res.json({ list: serialize(m, req.user) });
}));

router.get('/:id/qr', wrap(async (req, res) => {
  const m = await load(req.params.id, req.user);
  if (!m.verifyCode) throw new HttpError(404, 'Not approved yet.');
  const url = `${verification.baseUrl(req)}/verify/${m.verifyCode}`;
  res.json({ verifyCode: m.verifyCode, verifyUrl: url, qrDataUrl: await verification.qrDataUrl(url) });
}));

router.get('/:id/signature', wrap(async (req, res) => {
  const m = await load(req.params.id, req.user);
  if (!m.decision || !m.decision.image) throw new HttpError(404, 'Not approved.');
  const img = await store.read(m.decision.image);
  if (!img) throw new HttpError(404, 'Signature image missing.');
  res.set('Content-Type', img.contentType).set('Cache-Control', 'private, max-age=86400').send(img.buffer);
}));

// The public check (from verify.js): the approved mandatories and their totals.
async function verifyMandatory(code) {
  const m = await CashMandatory.findOne({ verifyCode: code });
  if (!m) return null;
  return {
    status: listHash(m) === m.contentHash ? 'valid' : 'tampered', code: m.verifyCode,
    document: `Monthly Mandatories: ${cf.monthName(m.month)} (${m.refNo})`,
    reference: `Total approved ${money(m.approvedTotal)}`,
    court: 'Office of the Hon. Chief Judge, Gombe State High Court of Justice',
    issuedAt: m.decision.at,
    signedBy: [{ capacity: 'Hon. Chief Judge', name: m.decision.byName, title: m.decision.title || null, signedAt: m.decision.at }],
    lines: m.items.filter(x => !x.struck).map(x => `${x.title} · ${x.payees.length} beneficiar${x.payees.length === 1 ? 'y' : 'ies'} · ${money(x.amount)}`)
  };
}

module.exports = router;
module.exports.verifyMandatory = verifyMandatory;

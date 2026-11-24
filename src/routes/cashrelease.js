/*
 * src/routes/cashrelease.js — requests for the release of funds.
 *
 *   After the Hon. Chief Judge approves items on the cash flow, the DCR
 *   Admin and Finance writes a request for the release of funds: one or
 *   more approved items, each with the beneficiaries to be paid (name,
 *   bank, account number) and the amount for each, in full or in part (an
 *   item may be released in instalments). The Chief Judge approves it with
 *   the signing PIN (several at once if he chooses), returns it with a
 *   query, or declines it. The Accountant then pays each beneficiary and
 *   records the payment voucher; the item is paid when all that was
 *   approved has been paid.
 */
const express = require('express');
const mongoose = require('mongoose');
const { CashItem, CashRelease, User } = require('../models');
const cf = require('../services/cashflow');
const store = require('../services/signatureStore');
const audit = require('../services/audit');
const { verifyPin } = require('./me');
const { HttpError, requireLogin } = require('../middleware/auth');
const { isCJ, isDCR, isAccountant, seesAll, tell, holders, money, text, DAY } = require('./cashflow').helpers;

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const meta = () => mongoose.connection.collection('appmeta');
async function nextRef() {
  const year = new Date().getFullYear();
  const r = await meta().findOneAndUpdate({ _id: `cashRelSeq:${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  const seq = (r && r.value ? r.value : r).seq;
  return `GSHC/CF/REL/${year}/${String(seq).padStart(4, '0')}`;
}

async function load(id, u) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Release not found.');
  const r = await CashRelease.findById(id);
  if (!r) throw new HttpError(404, 'Release not found.');
  if (!seesAll(u) && !(isAccountant(u) && ['approved', 'paid'].includes(r.status))) throw new HttpError(403, 'You do not have access to this release.');
  return r;
}

function serialize(r, u) {
  const o = r.toObject ? r.toObject() : r;
  return {
    id: String(o._id), refNo: o.refNo, status: o.status, total: o.total, note: o.note,
    items: o.items.map(x => ({ item: String(x.item), sn: x.sn, month: x.month, monthName: cf.monthName(x.month), name: x.name, amount: x.amount,
      payees: x.payees.map(p => ({ id: String(p._id), name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName, amount: p.amount, paid: p.paid })) })),
    paid: cf.round(o.items.reduce((n, x) => n + x.payees.reduce((m, p) => m + (p.paid ? p.paid.amount : 0), 0), 0)),
    requestedBy: String(o.requestedBy), requestedByName: o.requestedByName, createdAt: o.createdAt, query: o.query,
    decision: o.decision ? { kind: o.decision.kind, note: o.decision.note, byName: o.decision.byName, title: o.decision.title, at: o.decision.at,
      signatureUrl: o.decision.image ? `/api/cashflow/releases/${o._id}/signature` : null } : null,
    history: [...(o.history || [])].reverse(),
    can: {
      decide: isCJ(u) && o.status === 'pending',
      answer: String(o.requestedBy) === String(u._id) && o.status === 'returned',
      pay: isAccountant(u) && o.status === 'approved'
    }
  };
}

// The items and beneficiaries sent: approved items, each beneficiary with a
// ten digit account number, and no more than is left to release on each.
async function cleanItems(raw, except) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new HttpError(400, 'Choose at least one approved item.');
  if (list.length > 50) throw new HttpError(400, 'A release can cover up to 50 items.');
  const ids = list.map(x => String(x && x.item));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'An item appears twice.');
  if (!ids.every(i => mongoose.isValidObjectId(i))) throw new HttpError(400, 'Item not found.');
  const items = await CashItem.find({ _id: { $in: ids } });
  const rel = await cf.released(ids, except);
  return list.map((x) => {
    const it = items.find(i => String(i._id) === String(x.item));
    if (!it || it.status !== 'approved') throw new HttpError(409, `${it ? it.item : 'An item'} is not an approved item waiting for payment.`);
    const payees = Array.isArray(x.payees) ? x.payees : [];
    if (!payees.length) throw new HttpError(400, `Add the beneficiary for ${it.item}.`);
    if (payees.length > 30) throw new HttpError(400, 'Up to 30 beneficiaries for an item.');
    const clean = payees.map((p, j) => {
      const where = `${it.item}, beneficiary ${j + 1}`;
      const name = text(p && p.name, 150), bank = text(p && p.bank, 100), accountNo = String((p && p.accountNo) || '').replace(/\s/g, '');
      const amount = cf.round(Number(p && p.amount));
      if (!name) throw new HttpError(400, `Enter the name of ${where}.`);
      if (!bank) throw new HttpError(400, `Enter the bank of ${where}.`);
      if (!/^\d{10}$/.test(accountNo)) throw new HttpError(400, `The account number of ${where} must be 10 digits.`);
      if (!(amount > 0)) throw new HttpError(400, `Enter the amount for ${where}.`);
      return { name, bank, accountNo, accountName: text(p && p.accountName, 150) || name, amount, paid: null };
    });
    const amount = cf.round(clean.reduce((n, p) => n + p.amount, 0));
    const left = cf.round(it.decision.amount - (rel[String(it._id)] || 0));
    if (amount > left + 0.004) throw new HttpError(400, `${it.item}: ${money(amount)} is more than the ${money(left)} left to release of the ${money(it.decision.amount)} approved.`);
    return { item: it._id, sn: it.sn, month: it.month, name: it.item, amount, payees: clean };
  });
}
const totalOf = (items) => cf.round(items.reduce((n, x) => n + x.amount, 0));
const what = (r) => `${r.refNo} (${r.items.map(x => x.name).join('; ')}, ${money(r.total)})`;

// ── Lists ──
router.get('/', wrap(async (req, res) => {
  const u = req.user;
  if (!seesAll(u) && !isAccountant(u)) throw new HttpError(403, 'The release of funds is for the Hon. Chief Judge, the DCR Admin and Finance and the Accountant.');
  const q = seesAll(u) ? {} : { status: { $in: ['approved', 'paid'] } };
  if (['pending', 'returned', 'approved', 'declined', 'paid'].includes(req.query.status)) q.status = req.query.status;
  const list = await CashRelease.find(q).sort({ createdAt: -1 }).limit(300);
  res.json({ releases: list.map(r => serialize(r, u)), dcr: isDCR(u) });
}));

// Approved items with something left to release (for the DCR's form).
router.get('/open-items', wrap(async (req, res) => {
  if (!isDCR(req.user)) throw new HttpError(403, 'Only the DCR Admin and Finance requests the release of funds.');
  await cf.rollOver();
  const items = await CashItem.find({ status: 'approved' }).sort({ month: 1, sn: 1 });
  const except = mongoose.isValidObjectId(req.query.except) ? req.query.except : undefined;
  const rel = await cf.released(items.map(x => x._id), except);
  res.json({ items: items.map(it => ({ id: String(it._id), sn: it.sn, month: it.month, monthName: cf.monthName(it.month), item: it.item,
    requestedByName: it.requestedByName, approved: it.decision.amount, released: rel[String(it._id)] || 0, left: cf.round(it.decision.amount - (rel[String(it._id)] || 0)) }))
    .filter(x => x.left > 0.004) });
}));

// The Hon. Chief Judge approves several releases at once, with one PIN.
router.post('/decide-many', wrap(async (req, res) => {
  if (!isCJ(req.user)) throw new HttpError(403, 'Only the Hon. Chief Judge approves the release of funds.');
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))].filter(i => mongoose.isValidObjectId(i));
  if (!ids.length) throw new HttpError(400, 'Select the releases to approve.');
  if (ids.length > 100) throw new HttpError(400, 'Approve up to 100 releases at a time.');
  const list = await CashRelease.find({ _id: { $in: ids } });
  if (list.length !== ids.length || list.some(r => r.status !== 'pending')) throw new HttpError(409, 'Some of the releases selected are no longer waiting for a decision. Refresh the list.');
  const me = req.user;
  if (!me.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
  await verifyPin(me, req.body.pin);
  const note = text(req.body.note, 2000);
  for (const r of list) await approve(req, r, note);
  res.json({ approved: list.length, total: cf.round(list.reduce((n, r) => n + r.total, 0)) });
}));

async function approve(req, r, note) {
  const me = req.user;
  r.decision = { kind: 'approved', note, by: me._id, byName: me.fullName, title: me.title, at: new Date(), image: me.signature };
  r.status = 'approved';
  r.history.push({ action: 'approved', byName: me.fullName, note, at: new Date() });
  await r.save();
  await audit.log(req, 'cashrelease_approved', { details: { releaseId: String(r._id), refNo: r.refNo, total: r.total } });
  await tell(await User.find({ _id: r.requestedBy, active: true }), `The Hon. Chief Judge approved the release of funds ${what(r)}.`, 'Release of funds: approved');
  await tell(await holders('accountant'), `Release of funds approved, for payment: ${what(r)}.`, 'Release of funds: for payment');
}

router.get('/:rid', wrap(async (req, res) => {
  res.json({ release: serialize(await load(req.params.rid, req.user), req.user) });
}));

// A new request for the release of funds (the DCR Admin and Finance).
router.post('/', wrap(async (req, res) => {
  if (!isDCR(req.user)) throw new HttpError(403, 'Only the DCR Admin and Finance requests the release of funds.');
  const items = await cleanItems(req.body.items);
  const r = await CashRelease.create({ refNo: await nextRef(), items, total: totalOf(items), note: text(req.body.note, 3000),
    requestedBy: req.user._id, requestedByName: req.user.fullName,
    history: [{ action: 'requested', byName: req.user.fullName, note: money(totalOf(items)), at: new Date() }] });
  await audit.log(req, 'cashrelease_requested', { details: { releaseId: String(r._id), refNo: r.refNo, total: r.total } });
  await tell(await holders('chief_judge', req.user._id), `${req.user.fullName} (DCR Admin and Finance) requests the release of funds ${what(r)}.`, 'Release of funds: request');
  res.status(201).json({ release: serialize(r, req.user) });
}));

// The DCR answers a query (and may correct the release), and sends it back.
router.put('/:rid', wrap(async (req, res) => {
  const r = await load(req.params.rid, req.user);
  if (String(r.requestedBy) !== String(req.user._id) || r.status !== 'returned') throw new HttpError(409, 'Only a release returned to you with a query can be changed and sent back.');
  const answer = text(req.body.answer, 2000);
  if (!answer) throw new HttpError(400, 'Answer the query.');
  const items = await cleanItems(req.body.items, r._id);
  Object.assign(r, { items, total: totalOf(items), note: text(req.body.note, 3000), status: 'pending' });
  r.history.push({ action: 'answered', byName: req.user.fullName, note: answer, at: new Date() });
  await r.save();
  await audit.log(req, 'cashrelease_answered', { details: { releaseId: String(r._id), answer } });
  await tell(await holders('chief_judge', req.user._id), `${req.user.fullName} answered your query on the release of funds ${what(r)}: ${answer}`, 'Release of funds: query answered');
  res.json({ release: serialize(r, req.user) });
}));

// The Hon. Chief Judge: approve (with the PIN), return with a query, or decline.
router.post('/:rid/decide', wrap(async (req, res) => {
  if (!isCJ(req.user)) throw new HttpError(403, 'Only the Hon. Chief Judge approves the release of funds.');
  const r = await load(req.params.rid, req.user);
  if (r.status !== 'pending') throw new HttpError(409, 'This release is not waiting for a decision.');
  const action = String(req.body.action || '');
  const note = text(req.body.note, 2000);
  const me = req.user;
  if (action === 'approve') {
    if (!me.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
    await verifyPin(me, req.body.pin);
    await approve(req, r, note);
  } else if (action === 'return') {
    if (!note) throw new HttpError(400, 'Write the query.');
    r.query = { text: note, byName: me.fullName, at: new Date() };
    r.status = 'returned';
    r.history.push({ action: 'returned', byName: me.fullName, note, at: new Date() });
    await r.save();
    await audit.log(req, 'cashrelease_returned', { details: { releaseId: String(r._id), note } });
    await tell(await User.find({ _id: r.requestedBy, active: true }), `The Hon. Chief Judge returned the release of funds ${what(r)} with a query: ${note}`, 'Release of funds: query');
  } else if (action === 'decline') {
    r.decision = { kind: 'declined', note, by: me._id, byName: me.fullName, title: me.title, at: new Date() };
    r.status = 'declined';
    r.history.push({ action: 'declined', byName: me.fullName, note, at: new Date() });
    await r.save();
    await audit.log(req, 'cashrelease_declined', { details: { releaseId: String(r._id), note } });
    await tell(await User.find({ _id: r.requestedBy, active: true }), `The Hon. Chief Judge did not approve the release of funds ${what(r)}${note ? `: ${note}` : ''}. The amount is free to be requested again.`, 'Release of funds: not approved');
  } else throw new HttpError(400, 'Approve, return with a query, or decline.');
  res.json({ release: serialize(r, req.user) });
}));

// The Accountant pays a beneficiary of an approved release.
router.post('/:rid/pay', wrap(async (req, res) => {
  if (!isAccountant(req.user)) throw new HttpError(403, 'Only the Accountant records payments.');
  const r = await load(req.params.rid, req.user);
  if (r.status !== 'approved') throw new HttpError(409, 'Only an approved release can be paid.');
  let line = null, entry = null;
  r.items.forEach(x => x.payees.forEach(p => { if (String(p._id) === String(req.body.payee)) { line = p; entry = x; } }));
  if (!line) throw new HttpError(404, 'Beneficiary not found.');
  if (line.paid) throw new HttpError(409, `${line.name} has been paid.`);
  const pvNo = text(req.body.pvNo, 60);
  if (!pvNo) throw new HttpError(400, 'Enter the payment voucher number.');
  const date = DAY.test(req.body.date || '') ? req.body.date : new Date().toISOString().slice(0, 10);
  const amount = req.body.amount === undefined || req.body.amount === '' ? line.amount : cf.round(Number(req.body.amount));
  if (!(amount > 0) || amount > line.amount + 0.004) throw new HttpError(400, `The amount paid must be more than nothing and not more than the ${money(line.amount)} released to ${line.name}.`);
  const it = await CashItem.findById(entry.item);
  if (!it) throw new HttpError(404, 'The cash flow item is missing.');
  const at = new Date();
  line.paid = { pvNo, date, amount, byName: req.user.fullName, at };
  if (r.items.every(x => x.payees.every(p => p.paid))) { r.status = 'paid'; r.history.push({ action: 'paid', byName: req.user.fullName, note: 'Every beneficiary paid', at }); }
  r.markModified('items');
  await r.save();
  it.payments.push({ release: r._id, refNo: r.refNo, payee: line.name, bank: line.bank, accountNo: line.accountNo, pvNo, date, amount, month: it.month, byName: req.user.fullName, at });
  it.history.push({ action: 'paid', byName: req.user.fullName, note: `${money(amount)} to ${line.name}, PV ${pvNo} (release ${r.refNo})`, at });
  if (it.status === 'approved' && cf.paidOf(it) >= it.decision.amount - 0.004) it.status = 'paid';
  await it.save();
  await audit.log(req, 'cashflow_paid', { details: { itemId: String(it._id), releaseId: String(r._id), pvNo, amount, payee: line.name } });
  const msg = `Paid: ${money(amount)} to ${line.name} for ${it.item} (PV ${pvNo}, release ${r.refNo}).`;
  await tell([...await holders('chief_judge'), ...await User.find({ _id: { $in: [r.requestedBy, it.requestedBy] }, active: true })], msg, 'Cash flow: paid');
  res.json({ release: serialize(r, req.user) });
}));

router.get('/:rid/signature', wrap(async (req, res) => {
  const r = await load(req.params.rid, req.user);
  if (!r.decision || !r.decision.image) throw new HttpError(404, 'Not approved.');
  const img = await store.read(r.decision.image);
  if (!img) throw new HttpError(404, 'Signature image missing.');
  res.set('Content-Type', img.contentType).set('Cache-Control', 'private, max-age=86400').send(img.buffer);
}));

module.exports = router;

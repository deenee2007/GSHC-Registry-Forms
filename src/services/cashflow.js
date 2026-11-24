/*
 * src/services/cashflow.js — the monthly cash flow.
 *
 * Each month has the amount released (set by the administrator). The
 * balance carries from month to month: what is available in a month is its
 * release plus the balance brought forward; the balance goes down as
 * payments are made. Items still pending, returned with a query, or
 * approved but not yet paid when a month ends move into the new month's
 * cash flow by themselves; an item declined waits for the Chief Judge (or
 * the requester, if left to them) to carry it to the next cash flow or
 * dismiss it.
 */
const mongoose = require('mongoose');
const { CashItem, CashRelease } = require('../models');

const meta = () => mongoose.connection.collection('appmeta');
const RELEASES = 'cashflowReleases';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const thisMonth = (d = new Date()) => d.toISOString().slice(0, 7);
function nextMonth(m) {
  const [y, mm] = m.split('-').map(Number);
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
}
const monthName = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const bad = (status, message) => Object.assign(new Error(message), { status });

async function releases() {
  const doc = await meta().findOne({ _id: RELEASES });
  return (doc && doc.months) || {};
}
// Who entered each month's figure, and when.
async function releasesBy() {
  const doc = await meta().findOne({ _id: RELEASES });
  return (doc && doc.by) || {};
}
async function setRelease(month, amount, byName) {
  if (!MONTH.test(month || '')) throw bad(400, 'Choose the month.');
  const n = Number(amount);
  if (!(n >= 0) || n > 1e13) throw bad(400, 'Enter the amount released, in naira.');
  await meta().updateOne({ _id: RELEASES }, { $set: { [`months.${month}`]: Math.round(n * 100) / 100, [`by.${month}`]: { byName, at: new Date() } } }, { upsert: true });
}

// The next number on a month's list.
async function nextSn(month) {
  const r = await meta().findOneAndUpdate({ _id: `cashSeq:${month}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return (r && r.value ? r.value : r).seq;
}

// Items made before sections and lines: one line each (the quantity and
// unit price where given, else 1 × the amount). Once per start.
let migrated = false;
async function migrate() {
  if (migrated) return;
  const old = await CashItem.find({ $or: [{ sections: { $exists: false } }, { sections: { $size: 0 } }] });
  for (const it of old) await CashItem.updateOne({ _id: it._id }, { $set: { sections: oneLine(it) } });
  // A payment recorded before releases: into the list of payments.
  const paid = await CashItem.find({ payment: { $ne: null }, $or: [{ payments: { $exists: false } }, { payments: { $size: 0 } }] });
  for (const it of paid) await CashItem.updateOne({ _id: it._id }, { $set: { payments: [{ ...it.toObject().payment, month: it.month }] } });
  migrated = true;
}
function oneLine(it) {
  const both = it.quantity > 0 && it.unitPrice > 0;
  return [{ title: '', lines: [{ description: it.item, quantity: both ? it.quantity : 1, unitPrice: both ? it.unitPrice : it.amount, amount: it.amount, struck: false }] }];
}

// The sections and lines from a request form: quantity and unit price on
// every line; each line, each section and the item totalled here.
const round = (n) => Math.round(n * 100) / 100;
function cleanSections(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch (e) { list = null; } }
  if (!Array.isArray(list) || !list.length) throw bad(400, 'Add at least one line, with its quantity and unit price.');
  if (list.length > 30) throw bad(400, 'An item can have up to 30 sections.');
  const many = list.length > 1;
  const out = list.map((sec, i) => {
    const title = String((sec && sec.title) || '').trim().slice(0, 200);
    if (many && !title) throw bad(400, `Give section ${i + 1} a heading (for example, Roofing).`);
    const lines = Array.isArray(sec && sec.lines) ? sec.lines : [];
    if (!lines.length) throw bad(400, `${title || 'The item'} has no lines.`);
    if (lines.length > 100) throw bad(400, 'A section can have up to 100 lines.');
    return { title, lines: lines.map((l, j) => {
      const where = `${title ? `${title}, ` : ''}line ${j + 1}`;
      const description = String((l && l.description) || '').trim().slice(0, 300);
      const quantity = Number(l && l.quantity), unitPrice = Number(l && l.unitPrice);
      if (!description) throw bad(400, `Describe ${where}.`);
      if (!(quantity > 0) || quantity > 1e7) throw bad(400, `Enter the quantity for ${where}.`);
      if (!(unitPrice > 0) || unitPrice > 1e12) throw bad(400, `Enter the unit price for ${where}.`);
      return { description, quantity, unitPrice: round(unitPrice), amount: round(quantity * unitPrice), struck: false };
    }) };
  });
  const amount = round(out.reduce((n, sec) => n + sec.lines.reduce((m, l) => m + l.amount, 0), 0));
  if (amount > 1e13) throw bad(400, 'The total is too large.');
  return { sections: out, amount };
}
const subtotal = (sec, kept) => round(sec.lines.filter(l => !kept || !l.struck).reduce((n, l) => n + l.amount, 0));

// How much of each approved item is already in a release of funds (waiting,
// returned with a query, approved or paid; a declined one frees it). A
// beneficiary paid counts at what was paid. `except` leaves a release out
// (the one being corrected).
async function released(itemIds, except) {
  const ids = itemIds.map(String);
  const list = await CashRelease.find({ 'items.item': { $in: itemIds }, status: { $in: ['pending', 'returned', 'approved', 'paid'] }, ...(except ? { _id: { $ne: except } } : {}) });
  const out = Object.fromEntries(ids.map(i => [i, 0]));
  list.forEach(r => r.items.forEach(x => { const k = String(x.item); if (k in out) out[k] = round(out[k] + x.payees.reduce((n, p) => n + (p.paid ? p.paid.amount : p.amount), 0)); }));
  return out;
}
const paidOf = (it) => round((it.payments || []).reduce((n, p) => n + (p.amount || 0), 0));

// A new month: what was left waiting moves into it.
async function rollOver() {
  await migrate();
  const now = thisMonth();
  const left = await CashItem.find({ month: { $lt: now }, status: { $in: ['pending', 'returned', 'approved'] } });
  for (const it of left) {
    const from = it.month;
    it.carriedFrom = from;
    it.month = now;
    it.sn = await nextSn(now);
    it.history.push({ action: 'moved', byName: 'The system', note: `Moved from the ${monthName(from)} cash flow`, at: new Date() });
    await it.save();
  }
  return left.length;
}

// The money for a month: brought forward, released, available, approved, paid, balance.
async function summary(month) {
  const rel = await releases();
  const months = new Set(Object.keys(rel).filter(m => m <= month));
  (await CashItem.distinct('month', { month: { $lte: month } })).forEach(m => months.add(m));
  months.add(month);
  // Paid in a month: every payment made while the item was on that month's cash flow.
  const paidBy = Object.fromEntries((await CashItem.aggregate([
    { $unwind: '$payments' }, { $match: { 'payments.month': { $lte: month } } }, { $group: { _id: '$payments.month', n: { $sum: '$payments.amount' } } }
  ])).map(x => [x._id, x.n]));
  Object.keys(paidBy).forEach(m => months.add(m));
  let brought = 0, out = null;
  for (const m of [...months].sort()) {
    const released = rel[m] || 0, paid = paidBy[m] || 0;
    const available = brought + released;
    if (m === month) out = { month, broughtForward: brought, released, available, paid, balance: available - paid };
    brought = available - paid;
  }
  const approved = await CashItem.aggregate([{ $match: { month, status: { $in: ['approved', 'paid'] } } }, { $group: { _id: null, n: { $sum: '$decision.amount' } } }]);
  const asked = await CashItem.aggregate([{ $match: { month, status: { $in: ['pending', 'returned'] } } }, { $group: { _id: null, n: { $sum: '$amount' } } }]);
  return { ...out, approved: (approved[0] && approved[0].n) || 0, awaitingDecision: (asked[0] && asked[0].n) || 0,
    approvedUnpaid: ((approved[0] && approved[0].n) || 0) - (await CashItem.aggregate([{ $match: { month, status: { $in: ['approved', 'paid'] } } }, { $unwind: '$payments' }, { $group: { _id: null, n: { $sum: '$payments.amount' } } }]).then(r => (r[0] && r[0].n) || 0)) };
}

module.exports = { releasesBy, released, paidOf, round, migrate, oneLine, cleanSections, subtotal, thisMonth, nextMonth, monthName, releases, setRelease, nextSn, rollOver, summary, MONTH };

/*
 * src/routes/statistics.js — figures for the Hon. Chief Judge (and
 * administrators) on the work of the courts, from the Case Registers and
 * the court diaries:
 *
 *   for each court, in a period: cases assigned, cases disposed of,
 *   sittings and adjournments; and now: cases pending, how long they have
 *   been pending (in bands), the oldest, and dates fixed to come.
 *
 * A pending case is one in a court's register not yet disposed of. Its age
 * runs from the date of assignment (for a case entered as an earlier case
 * without one, from its date of filing, else the date its file was received).
 */
const express = require('express');
const { Case, Unit, DiaryEntry } = require('../models');
const processSvc = require('../services/process');
const { HttpError, requireLogin, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);
router.use((req, res, next) => (isAdmin(req.user) || req.user.signerRoles.includes('chief_judge')) ? next()
  : next(new HttpError(403, 'Court statistics are for the Hon. Chief Judge and administrators.')));

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const IN_REGISTER = ['assigned', 'dispatched', 'received', 'disposed'];
const BANDS = [['under1', 'Under 1 year', 0, 1], ['y1to3', '1 to 3 years', 1, 3], ['y3to5', '3 to 5 years', 3, 5], ['over5', 'Over 5 years', 5, Infinity]];
const YEAR_MS = 365.25 * 86400000;
const parties = (c) => [c.firstParty, c.secondParty].map(p => String(p || '').trim().replace(/\s*\n+\s*/g, ', ')).filter(Boolean).join(' v. ');
const started = (c) => c.assignedAt ? new Date(c.assignedAt) : c.filedOn ? new Date(c.filedOn + 'T12:00:00Z')
  : c.receivedAt ? new Date(c.receivedAt) : c.createdAt ? new Date(c.createdAt) : null;

function period(q) {
  const now = new Date();
  const from = DAY.test(q.from || '') ? q.from : `${now.getFullYear()}-01-01`;
  const to = DAY.test(q.to || '') ? q.to : iso(now);
  if (from > to) throw new HttpError(400, 'The start of the period must come before its end.');
  return { from, to, fromDate: new Date(from + 'T00:00:00'), toDate: new Date(to + 'T23:59:59.999') };
}

async function courts() {
  return (await Unit.find({ type: 'registry' }, 'key name courtNo active').lean()).sort((a, b) => (a.courtNo || 0) - (b.courtNo || 0));
}

// Per court figures for the period, with the totals.
router.get('/', wrap(async (req, res) => {
  const p = period(req.query);
  const today = iso(new Date());
  const [list, cases, diary] = await Promise.all([
    courts(),
    Case.find({ status: { $in: IN_REGISTER }, assignedUnit: { $exists: true } }, 'assignedUnit status assignedAt filedOn receivedAt createdAt earlier disposal').lean(),
    DiaryEntry.find({ $or: [{ date: { $gte: p.from, $lte: p.to } }, { status: 'fixed', date: { $gte: today } }] }, 'unitKey date status outcome').lean()
  ]);
  const now = Date.now();
  const rows = list.map(u => {
    const mine = cases.filter(c => c.assignedUnit === u.key);
    const pending = mine.filter(c => c.status !== 'disposed');
    const ages = pending.map(c => { const s = started(c); return s ? (now - s.getTime()) / YEAR_MS : 0; });
    const bands = Object.fromEntries(BANDS.map(([k, , lo, hi]) => [k, ages.filter(a => a >= lo && a < hi).length]));
    const sat = diary.filter(e => e.unitKey === u.key && e.status === 'done' && e.date >= p.from && e.date <= p.to);
    return {
      key: u.key, name: u.name, courtNo: u.courtNo, roman: processSvc.roman(u.courtNo), active: u.active !== false,
      assigned: mine.filter(c => !c.earlier && c.assignedAt && c.assignedAt >= p.fromDate && c.assignedAt <= p.toDate).length,
      disposed: mine.filter(c => c.disposal && c.disposal.date >= p.from && c.disposal.date <= p.to).length,
      pending: pending.length,
      averageYears: ages.length ? Math.round(ages.reduce((n, a) => n + a, 0) / ages.length * 10) / 10 : 0,
      oldestYears: ages.length ? Math.round(Math.max(...ages) * 10) / 10 : 0,
      bands,
      sittings: sat.length,
      adjournments: sat.filter(e => e.outcome && e.outcome.nextDate).length,
      toCome: diary.filter(e => e.unitKey === u.key && e.status === 'fixed' && e.date >= today).length
    };
  }).filter(r => r.active || r.pending || r.assigned || r.disposed);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const totals = {
    assigned: sum('assigned'), disposed: sum('disposed'), pending: sum('pending'), sittings: sum('sittings'), adjournments: sum('adjournments'), toCome: sum('toCome'),
    bands: Object.fromEntries(BANDS.map(([k]) => [k, rows.reduce((n, r) => n + r.bands[k], 0)]))
  };
  res.json({ from: p.from, to: p.to, bands: BANDS.map(([key, label]) => ({ key, label })), courts: rows, totals });
}));

// One court's pending cases, oldest first, with their adjournments and dates.
router.get('/pending', wrap(async (req, res) => {
  const unit = await Unit.findOne({ key: String(req.query.unitKey || ''), type: 'registry' }).lean();
  if (!unit) throw new HttpError(404, 'Court not found.');
  const today = iso(new Date());
  const [cases, diary] = await Promise.all([
    Case.find({ assignedUnit: unit.key, status: { $in: ['assigned', 'dispatched', 'received'] } }, 'suitNumber firstParty secondParty nature status assignedAt filedOn receivedAt createdAt earlier').lean(),
    DiaryEntry.find({ unitKey: unit.key, case: { $exists: true } }, 'case date status outcome business').lean()
  ]);
  const now = Date.now();
  const list = cases.map(c => {
    const s = started(c);
    const mine = diary.filter(e => String(e.case) === String(c._id));
    const sat = mine.filter(e => e.status === 'done').sort((a, b) => b.date.localeCompare(a.date));
    const next = mine.filter(e => e.status === 'fixed' && e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
    return {
      id: String(c._id), suitNumber: c.suitNumber, parties: parties(c), nature: c.nature || '', status: c.status, earlier: !!c.earlier,
      since: s ? iso(s) : '', years: s ? Math.round((now - s.getTime()) / YEAR_MS * 10) / 10 : 0, days: s ? Math.floor((now - s.getTime()) / 86400000) : 0,
      sittings: sat.length, adjournments: sat.filter(e => e.outcome && e.outcome.nextDate).length,
      lastSitting: sat[0] ? sat[0].date : '', nextDate: next ? next.date : '', nextBusiness: next ? next.business : ''
    };
  }).sort((a, b) => b.years - a.years || String(a.suitNumber).localeCompare(String(b.suitNumber), undefined, { numeric: true }));
  res.json({ court: { key: unit.key, name: unit.name, roman: processSvc.roman(unit.courtNo) }, cases: list });
}));

module.exports = router;

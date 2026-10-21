/*
 * src/routes/diary.js — each court's diary, shared by its registry and its
 * judges: the dates fixed for cases, what each sitting is for, and what
 * happened (an adjournment makes the next entry). The parties and counsel
 * of a registered case are emailed each date fixed or changed. The day's
 * entries draw the cause list (on the client, into the Cause List form).
 */
const express = require('express');
const mongoose = require('mongoose');
const { DiaryEntry, Case, Unit } = require('../models');
const processSvc = require('../services/process');
const caseEmail = require('../services/caseEmail');
const audit = require('../services/audit');
const { HttpError, requireLogin, canAccessUnit, can } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
// Who sees a court's diary: its staff and its judges (anyone with a signing role there).
const canView = (u, key) => !!key && canAccessUnit(u, key) && (can(u, 'view') || u.signerRoles.length > 0);
// Who writes in it: staff who create or edit, and the court's judges.
const canWrite = (u, key) => canView(u, key) && (can(u, 'create') || can(u, 'edit') || u.signerRoles.length > 0);
const partiesOf = (c) => [c.firstParty, c.secondParty].map(p => String(p || '').trim().replace(/\s*\n+\s*/g, ', ')).filter(Boolean).join(' v. ');

async function court(key) {
  const unit = await Unit.findOne({ key: String(key || ''), type: 'registry' });
  if (!unit) throw new HttpError(404, 'Court not found.');
  return unit;
}

const serialize = (e, u) => ({
  id: String(e._id), unitKey: e.unitKey, date: e.date, time: e.time || '', caseId: e.case ? String(e.case) : null,
  suitNumber: e.suitNumber, parties: e.parties, nature: e.nature, counsel: e.counsel,
  business: e.business, notes: e.notes, status: e.status, outcome: e.outcome || null,
  createdByName: e.createdByName, updatedByName: e.updatedByName, updatedAt: e.updatedAt,
  canWrite: canWrite(u, e.unitKey)
});

// The business: one from the list in Settings, or typed under Others.
async function business(body) {
  let b = String(body.business || '').trim();
  if (b === 'Others') b = String(body.other || '').trim();
  if (!b) throw new HttpError(400, 'Choose what the case is coming up for, or type it under Others.');
  return b.slice(0, 80);
}

// A day already full in this court (the limit set in Settings), unless told to go ahead.
async function checkLimit(unitKey, date, force, except) {
  const { dailyLimit } = await processSvc.getSettings();
  if (!dailyLimit || force) return;
  const n = await DiaryEntry.countDocuments({ unitKey, date, status: 'fixed', ...(except ? { _id: { $ne: except } } : {}) });
  if (n >= dailyLimit) {
    throw Object.assign(new HttpError(409, `There are already ${n} cases in the diary on that day (the limit is ${dailyLimit}). Choose another day, or fix it anyway.`), { extra: { full: true } });
  }
}

// Email the parties and counsel of a registered case about a date.
async function tellParties(e, changed) {
  if (!e.case) return;
  const c = await Case.findById(e.case);
  if (!c) return;
  await caseEmail.notify(c, 'hearing', await Unit.findOne({ key: e.unitKey }), { date: e.date, time: e.time, business: e.business, changed });
}

// A new entry: a case from the court's register (caseId), or one typed in.
async function makeEntry(req, src) {
  const unit = await court(src.unitKey);
  if (!canWrite(req.user, unit.key)) throw new HttpError(403, 'Only the staff and judges of this court write in its diary.');
  if (!DAY.test(src.date || '')) throw new HttpError(400, 'Choose the date.');
  if (src.time && !TIME.test(src.time)) throw new HttpError(400, 'Enter the time as HH:MM, for example 09:00.');
  const fields = { unitKey: unit.key, date: src.date, time: src.time || '', business: await business(src), notes: String(src.notes || '').trim().slice(0, 1000) };
  if (src.caseId) {
    if (!mongoose.isValidObjectId(src.caseId)) throw new HttpError(404, 'Case not found.');
    const c = await Case.findById(src.caseId);
    if (!c || c.assignedUnit !== unit.key || !['assigned', 'dispatched', 'received', 'disposed'].includes(c.status)) throw new HttpError(400, 'That case is not in this court\'s register.');
    Object.assign(fields, { case: c._id, suitNumber: c.suitNumber, parties: partiesOf(c), nature: c.nature || '', counsel: c.counsel || '' });
  } else {
    const suitNumber = String(src.suitNumber || '').trim().slice(0, 60);
    if (!suitNumber) throw new HttpError(400, 'Choose the case, or type its suit number.');
    Object.assign(fields, { suitNumber, parties: String(src.parties || '').trim().slice(0, 300), nature: String(src.nature || '').trim().slice(0, 200), counsel: String(src.counsel || '').trim().slice(0, 200) });
  }
  await checkLimit(unit.key, fields.date, !!src.force);
  return new DiaryEntry({ ...fields, createdBy: req.user._id, createdByName: req.user.fullName, updatedByName: req.user.fullName });
}

async function loadEntry(id, user) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Diary entry not found.');
  const e = await DiaryEntry.findById(id);
  if (!e || !canView(user, e.unitKey)) throw new HttpError(404, 'Diary entry not found.');
  return e;
}

// The entries of a court between two days (or of one case).
router.get('/', wrap(async (req, res) => {
  const unit = await court(req.query.unitKey);
  if (!canView(req.user, unit.key)) throw new HttpError(403, 'You do not have access to this court\'s diary.');
  const q = { unitKey: unit.key };
  if (req.query.caseId) {
    if (!mongoose.isValidObjectId(req.query.caseId)) throw new HttpError(404, 'Case not found.');
    q.case = req.query.caseId;
  } else {
    const from = DAY.test(req.query.from || '') ? req.query.from : null;
    const to = DAY.test(req.query.to || '') ? req.query.to : from;
    if (!from) throw new HttpError(400, 'Choose the days to show.');
    q.date = { $gte: from, $lte: to };
  }
  const list = await DiaryEntry.find(q).sort({ date: 1, time: 1, createdAt: 1 }).limit(2000);
  const s = await processSvc.getSettings();
  res.json({ entries: list.map(e => serialize(e, req.user)), canWrite: canWrite(req.user, unit.key), businessTypes: s.businessTypes, dailyLimit: s.dailyLimit });
}));

router.post('/', wrap(async (req, res) => {
  const e = await makeEntry(req, req.body || {});
  await e.save();
  await audit.log(req, 'diary_date_fixed', { unitKey: e.unitKey, details: { entryId: String(e._id), suitNumber: e.suitNumber, date: e.date, business: e.business } });
  await tellParties(e, false);
  res.status(201).json({ entry: serialize(e, req.user) });
}));

// Move or correct a date still to come.
router.put('/:id', wrap(async (req, res) => {
  const e = await loadEntry(req.params.id, req.user);
  if (!canWrite(req.user, e.unitKey)) throw new HttpError(403, 'Only the staff and judges of this court write in its diary.');
  if (e.status !== 'fixed') throw new HttpError(409, 'The outcome of this sitting is already recorded.');
  const b = req.body || {};
  const before = { date: e.date, time: e.time, business: e.business };
  if (b.date !== undefined) { if (!DAY.test(b.date)) throw new HttpError(400, 'Choose the date.'); e.date = b.date; }
  if (b.time !== undefined) { if (b.time && !TIME.test(b.time)) throw new HttpError(400, 'Enter the time as HH:MM, for example 09:00.'); e.time = b.time || ''; }
  if (b.business !== undefined) e.business = await business(b);
  if (b.notes !== undefined) e.notes = String(b.notes || '').trim().slice(0, 1000);
  if (e.date !== before.date) await checkLimit(e.unitKey, e.date, !!b.force, e._id);
  e.updatedByName = req.user.fullName;
  await e.save();
  await audit.log(req, 'diary_date_changed', { unitKey: e.unitKey, details: { entryId: String(e._id), suitNumber: e.suitNumber, from: before, to: { date: e.date, time: e.time, business: e.business } } });
  if (e.date !== before.date || e.time !== before.time || e.business !== before.business) await tellParties(e, true);
  res.json({ entry: serialize(e, req.user) });
}));

// After the sitting: what happened, the next date (a new entry), and for a
// registered case, its disposal in the Case Register.
router.post('/:id/outcome', wrap(async (req, res) => {
  const e = await loadEntry(req.params.id, req.user);
  if (!canWrite(req.user, e.unitKey)) throw new HttpError(403, 'Only the staff and judges of this court write in its diary.');
  const b = req.body || {};
  const text = String(b.outcome || '').trim().slice(0, 1000);
  if (!text) throw new HttpError(400, 'Say what happened at the sitting.');
  let next = null;
  if (b.nextDate) {
    next = await makeEntry(req, { unitKey: e.unitKey, caseId: e.case ? String(e.case) : null, suitNumber: e.suitNumber, parties: e.parties, nature: e.nature, counsel: e.counsel,
      date: b.nextDate, time: b.nextTime, business: b.nextBusiness, other: b.nextOther, force: b.force });
    if (next.date <= e.date) throw new HttpError(400, 'The next date must be after this sitting.');
    next.previous = e._id;
  }
  let disposal = String(b.disposal || '').trim();
  if (disposal === 'Other') disposal = String(b.disposalOther || '').trim();
  const c = disposal && e.case ? await Case.findById(e.case) : null;
  if (disposal && !c) throw new HttpError(400, 'Only a case in the Case Register can be marked disposed here.');
  e.status = 'done';
  e.outcome = { text, nextDate: next ? next.date : '', at: new Date(), byName: req.user.fullName };
  e.updatedByName = req.user.fullName;
  await e.save();
  if (next) { await next.save(); await tellParties(next, false); }
  if (c) {
    c.disposal = { remark: disposal.slice(0, 300), date: e.date, byName: req.user.fullName, at: new Date() };
    c.status = 'disposed';
    if (!c.receivedAt) Object.assign(c, { receivedAt: new Date(), receivedByName: req.user.fullName });
    await c.save();
    await audit.log(req, 'case_disposed', { unitKey: c.assignedUnit, details: { caseId: String(c._id), suitNumber: c.suitNumber, remark: disposal, from: 'diary' } });
  }
  await audit.log(req, 'diary_outcome', { unitKey: e.unitKey, details: { entryId: String(e._id), suitNumber: e.suitNumber, outcome: text, nextDate: next ? next.date : null } });
  res.json({ entry: serialize(e, req.user), next: next ? serialize(next, req.user) : null });
}));

router.delete('/:id', wrap(async (req, res) => {
  const e = await loadEntry(req.params.id, req.user);
  if (!canWrite(req.user, e.unitKey)) throw new HttpError(403, 'Only the staff and judges of this court write in its diary.');
  await DiaryEntry.deleteOne({ _id: e._id });
  await audit.log(req, 'diary_entry_removed', { unitKey: e.unitKey, details: { suitNumber: e.suitNumber, date: e.date, business: e.business } });
  res.json({ deleted: true });
}));

module.exports = router;
module.exports.canView = canView;

/*
 * src/routes/reports.js — activity reports.
 *
 * Administrators see every unit and can filter by court. Other users need
 * the "reports" privilege and always see only their own unit(s); any court
 * filter they send is ignored.
 *
 * Everything counts what happened in the chosen period: forms created,
 * submitted, signed (final), returned and revoked, with approval times.
 * The form, status and signer filters narrow which records are counted.
 */
const express = require('express');
const mongoose = require('mongoose');
const { Record, Unit, User, AuditLog } = require('../models');
const catalogue = require('../forms/catalogue');
const { HttpError, requireLogin, isAdmin, can } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

function requireReports(req, res, next) {
  if (isAdmin(req.user)) return next();
  if (!can(req.user, 'reports')) return next(new HttpError(403, 'You do not have access to reports.'));
  if (!req.user.unitKeys.length) return next(new HttpError(403, 'Reports cover your own unit, and no unit is assigned to your account.'));
  next();
}
router.use(requireReports);

// Units this user's report may cover.
async function scopeUnits(user) {
  const units = await Unit.find().sort({ type: 1, courtNo: 1, name: 1 });
  return isAdmin(user) ? units : units.filter(u => user.unitKeys.includes(u.key));
}

// "YYYY-MM-DD" in the court's time zone (process TZ is set in config.js).
function parseDay(s, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return isNaN(d) ? null : d;
}

const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

router.get('/options', wrap(async (req, res) => {
  const units = await scopeUnits(req.user);
  const formKeys = new Set(units.flatMap(u => catalogue.formsForUnit(u)));
  const signers = await User.find({ 'signerRoles.0': { $exists: true } }).sort({ fullName: 1 });
  res.json({
    isAdmin: isAdmin(req.user),
    units: units.map(u => ({ key: u.key, name: u.name })),
    forms: [...formKeys].map(k => ({ formType: k, label: catalogue.get(k).label })).sort((a, b) => a.label.localeCompare(b.label)),
    signers: signers.filter(s => isAdmin(req.user) || !s.unitKeys.length || s.unitKeys.some(k => req.user.unitKeys.includes(k)))
      .map(s => ({ id: String(s._id), name: [s.title, s.fullName].filter(Boolean).join(' ') }))
  });
}));

router.get('/', wrap(async (req, res) => {
  const from = parseDay(req.query.from, false);
  const to = parseDay(req.query.to, true);
  if (!from || !to) throw new HttpError(400, 'Choose the start and end dates of the report.');
  if (from > to) throw new HttpError(400, 'The start date must be before the end date.');
  if (to - from > 3700 * 86400000) throw new HttpError(400, 'Choose a period of ten years or less.');

  const admin = isAdmin(req.user);
  let units = await scopeUnits(req.user);
  if (admin && req.query.unitKey) units = units.filter(u => u.key === String(req.query.unitKey));
  const unitKeys = units.map(u => u.key);
  const unitName = Object.fromEntries(units.map(u => [u.key, u.name]));

  const base = { unitKey: { $in: unitKeys } };
  if (req.query.formType) base.formType = String(req.query.formType);
  if (req.query.status) base.status = String(req.query.status);
  if (req.query.signer && mongoose.isValidObjectId(req.query.signer)) {
    const sid = new mongoose.Types.ObjectId(String(req.query.signer));
    base.$and = [{ $or: [{ 'slots.approvers': sid }, { 'slots.signatures.user': sid }] }];
  }

  const inRange = { $gte: from, $lte: to };
  const audits = await AuditLog.find({ action: { $in: ['record_returned', 'record_approved'] }, at: inRange, unitKey: { $in: unitKeys } })
    .select('action at record').lean();
  const auditIds = audits.map(a => a.record).filter(Boolean);

  const records = await Record.find({
    ...base,
    $or: [
      { createdAt: inRange }, { submittedAt: inRange }, { finalizedAt: inRange }, { revokedAt: inRange },
      { 'slots.signatures.signedAt': inRange }, { _id: { $in: auditIds } }
    ]
  }).select('-data -slots.signatures.image').lean();
  const byId = new Map(records.map(r => [String(r._id), r]));
  const within = (d) => d && d >= from && d <= to;

  // Counters, by form and by unit.
  const blank = () => ({ created: 0, submitted: 0, signed: 0, returned: 0, revoked: 0 });
  const totals = blank(), byForm = {}, byUnit = {};
  const bump = (r, field) => {
    totals[field]++;
    (byForm[r.formType] = byForm[r.formType] || blank())[field]++;
    (byUnit[r.unitKey] = byUnit[r.unitKey] || blank())[field]++;
  };
  for (const r of records) {
    if (within(r.createdAt)) bump(r, 'created');
    if (within(r.submittedAt)) bump(r, 'submitted');
    if (within(r.finalizedAt)) bump(r, 'signed');
    if (within(r.revokedAt)) bump(r, 'revoked');
  }

  // Returns and approval times come from the audit log, which keeps every
  // event (a record can be returned more than once).
  const approvalHours = [];
  for (const a of audits) {
    const r = byId.get(String(a.record));
    if (!r) continue; // filtered out
    if (a.action === 'record_returned') bump(r, 'returned');
    if (a.action === 'record_approved' && r.submittedAt) approvalHours.push(hoursBetween(r.submittedAt, a.at));
  }

  // Signatures placed in the period, by signer.
  const signers = {};
  for (const r of records) {
    for (const s of r.slots || []) {
      for (const g of s.signatures || []) {
        if (!within(g.signedAt)) continue;
        const k = String(g.user);
        const e = signers[k] = signers[k] || { id: k, name: [g.title, g.name].filter(Boolean).join(' '), signatures: 0, waits: [] };
        e.signatures++;
        if (r.submittedBy && String(r.submittedBy) !== k && r.submittedAt) e.waits.push(hoursBetween(r.submittedAt, g.signedAt));
      }
    }
  }

  // Waiting now (not limited to the period).
  const pendingNow = base.status && base.status !== 'pending' ? []
    : await Record.find({ ...base, status: 'pending' }).select('submittedAt').sort({ submittedAt: 1 }).lean();

  // The list of documents: those signed in the period, or created in it.
  const basis = req.query.basis === 'created' ? 'created' : 'signed';
  const listed = records
    .filter(r => within(basis === 'created' ? r.createdAt : r.finalizedAt))
    .sort((a, b) => new Date(basis === 'created' ? a.createdAt : a.finalizedAt) - new Date(basis === 'created' ? b.createdAt : b.finalizedAt))
    .slice(0, 2000)
    .map(r => ({
      id: String(r._id), ref: r.ref, summary: r.summary,
      form: (catalogue.get(r.formType) || { label: r.formType }).label,
      unit: unitName[r.unitKey] || r.unitKey, status: r.status,
      createdAt: r.createdAt, createdByName: r.createdByName,
      submittedAt: r.submittedAt, finalizedAt: r.finalizedAt, verifyCode: r.verifyCode,
      signedBy: (r.slots || []).flatMap(s => (s.signatures || []).map(g => [g.title, g.name].filter(Boolean).join(' '))).join('; ')
    }));

  const label = (k) => (catalogue.get(k) || { label: k }).label;
  res.json({
    period: { from: req.query.from, to: req.query.to },
    scope: { admin, units: units.map(u => ({ key: u.key, name: u.name })) },
    totals: {
      ...totals,
      approvals: approvalHours.length,
      avgApprovalHours: avg(approvalHours),
      medianApprovalHours: median(approvalHours),
      pendingNow: pendingNow.length,
      oldestPendingSince: pendingNow.length ? pendingNow[0].submittedAt : null
    },
    byForm: Object.entries(byForm).map(([k, v]) => ({ formType: k, label: label(k), ...v })).sort((a, b) => a.label.localeCompare(b.label)),
    byUnit: admin ? Object.entries(byUnit).map(([k, v]) => ({ unitKey: k, name: unitName[k] || k, ...v })).sort((a, b) => a.name.localeCompare(b.name)) : undefined,
    bySigner: Object.values(signers).map(s => ({ id: s.id, name: s.name, signatures: s.signatures, avgWaitHours: avg(s.waits) }))
      .sort((a, b) => b.signatures - a.signatures),
    basis,
    records: listed,
    truncated: listed.length === 2000
  });
}));

module.exports = router;

/*
 * src/routes/records.js — form records and the signing workflow.
 *
 *   draft ──submit──▶ pending ──approve (all lines signed)──▶ final
 *     ▲                  │                                     │
 *     └──── returned ◀───┘ return with comments           revoke ▼
 *                                                         revoked
 *
 * A signature line the submitter can sign themselves (e.g. a Registrar on a
 * hearing notice) is signed at submission, so a form with only such lines
 * goes straight to final. Once final, a record can never be edited.
 */
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { Record, Unit, User, FormConfig } = require('../models');
const catalogue = require('../forms/catalogue');
const verification = require('../services/verification');
const store = require('../services/signatureStore');
const audit = require('../services/audit');
const documentCopy = require('../services/documentCopy');
const { notify } = require('../services/notify');
const { verifyPin } = require('./me');
const { HttpError, requireLogin, canAccessUnit, can, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

// Signing attempts are limited on top of the per user PIN lockout.
const signLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many signing attempts. Please wait a few minutes.' }
});

// ── Helpers ──
const same = (a, b) => String(a) === String(b);
const slotDone = (s) => s.rule === 'all'
  ? s.approvers.length > 0 && s.approvers.every(a => s.signatures.some(g => same(g.user, a._id || a)))
  : s.signatures.length > 0;
const allDone = (rec) => rec.slots.every(slotDone);
const isApprover = (rec, user) => rec.slots.some(s => s.approvers.some(a => same(a._id || a, user._id)));

async function loadRecord(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Record not found.');
  const rec = await Record.findById(id);
  if (!rec) throw new HttpError(404, 'Record not found.');
  return rec;
}

function canView(user, rec) {
  if (isAdmin(user)) return true;
  if (isApprover(rec, user) || same(rec.createdBy, user._id) || same(rec.submittedBy, user._id)) return true;
  return canAccessUnit(user, rec.unitKey) && can(user, 'view');
}

function assertUnitAction(user, rec, action) {
  if (!canAccessUnit(user, rec.unitKey) || !can(user, action)) {
    throw new HttpError(403, 'You do not have permission to do that.');
  }
}

function assertEditable(rec) {
  if (!['draft', 'returned'].includes(rec.status)) {
    throw new HttpError(409, rec.status === 'pending'
      ? 'This record is awaiting signature and cannot be changed. Withdraw it first.'
      : 'This record is signed and locked. It cannot be changed.');
  }
}

async function saveRecord(rec) {
  try { await rec.save(); }
  catch (e) {
    if (e.name === 'VersionError') throw new HttpError(409, 'Someone else changed this record at the same time. Reload and try again.');
    throw e;
  }
}

function signatureFor(user) {
  return { user: user._id, name: user.fullName, title: user.title, image: user.signature, signedAt: new Date() };
}

function requireReadyToSign(user) {
  if (!user.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
}

async function finalize(req, rec) {
  rec.status = 'final';
  rec.finalizedAt = new Date();
  for (let i = 0; i < 5; i++) {
    const code = verification.newCode();
    if (!(await Record.exists({ verifyCode: code }))) { rec.verifyCode = code; break; }
  }
  rec.verifyUrl = `${verification.baseUrl(req)}/verify/${rec.verifyCode}`;
  rec.contentHash = verification.hashRecord(rec);
}

function serialize(rec, forms) {
  const o = rec.toObject({ versionKey: true });
  const def = catalogue.get(o.formType);
  return {
    id: String(o._id), version: o.__v, unitKey: o.unitKey, formType: o.formType,
    formLabel: def ? def.label : o.formType, status: o.status, ref: o.ref, summary: o.summary, caseNos: o.caseNos || [],
    data: forms === false ? undefined : o.data,
    slots: o.slots.map(s => ({
      role: s.role, label: s.label, rule: s.rule,
      approvers: s.approvers.map(a => (a && a.fullName ? { id: String(a._id), fullName: a.fullName, title: a.title } : { id: String(a) })),
      signatures: s.signatures.map(g => ({ user: String(g.user), name: g.name, title: g.title, signedAt: g.signedAt })),
      done: slotDone(s)
    })),
    createdBy: String(o.createdBy), createdByName: o.createdByName, createdAt: o.createdAt, updatedAt: o.updatedAt,
    submittedBy: o.submittedBy ? String(o.submittedBy) : null, submittedByName: o.submittedByName, submittedAt: o.submittedAt,
    returnComment: o.returnComment, returnedBy: o.returnedBy, returnedAt: o.returnedAt,
    finalizedAt: o.finalizedAt, verifyCode: o.verifyCode, verifyUrl: o.verifyUrl,
    revokedAt: o.revokedAt, revokedBy: o.revokedBy, revokeReason: o.revokeReason,
    firstPrintedAt: o.firstPrintedAt, printCount: o.printCount
  };
}

const POPULATE = { path: 'slots.approvers', select: 'fullName title' };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Lists ──
router.get('/', wrap(async (req, res) => {
  const q = {};
  const unitKey = req.query.unitKey ? String(req.query.unitKey) : null;
  if (unitKey) {
    if (!canAccessUnit(req.user, unitKey) || !can(req.user, 'view')) throw new HttpError(403, 'You do not have access to this unit.');
    q.unitKey = unitKey;
  } else if (!isAdmin(req.user)) {
    throw new HttpError(400, 'Choose a unit.');
  }
  if (req.query.status) q.status = String(req.query.status);
  if (req.query.formType) q.formType = String(req.query.formType);
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q).slice(0, 100)), 'i');
    q.$or = [{ ref: rx }, { summary: rx }, { createdByName: rx }];
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const recs = await Record.find(q).sort({ createdAt: -1 }).limit(limit).populate(POPULATE);
  res.json({ records: recs.map(r => serialize(r, false)) });
}));

// Waiting for my signature.
router.get('/inbox', wrap(async (req, res) => {
  const recs = await Record.find({ status: 'pending', 'slots.approvers': req.user._id }).sort({ submittedAt: 1 }).populate(POPULATE);
  const mine = recs.filter(r => r.slots.some(s => !slotDone(s) &&
    s.approvers.some(a => same(a._id, req.user._id)) && !s.signatures.some(g => same(g.user, req.user._id))));
  res.json({ records: mine.map(r => serialize(r, false)) });
}));

// Forms I submitted, by outcome: approved (ready to print), returned, pending.
router.get('/submitted', wrap(async (req, res) => {
  const status = ['final', 'returned', 'pending', 'revoked'].includes(req.query.status) ? req.query.status : 'final';
  const sort = status === 'final' ? { finalizedAt: -1 } : { updatedAt: -1 };
  const recs = await Record.find({ submittedBy: req.user._id, status }).sort(sort).limit(200).populate(POPULATE);
  res.json({ records: recs.map(r => serialize(r, false)) });
}));

// Counts by unit and status, for the units this user can see.
router.get('/stats', wrap(async (req, res) => {
  const units = await Unit.find({ active: true });
  const keys = units.map(u => u.key).filter(k => canAccessUnit(req.user, k));
  const rows = await Record.aggregate([
    { $match: { unitKey: { $in: keys } } },
    { $group: { _id: { unitKey: '$unitKey', status: '$status' }, n: { $sum: 1 } } }
  ]);
  const byUnit = {};
  keys.forEach(k => { byUnit[k] = { draft: 0, pending: 0, returned: 0, final: 0, revoked: 0 }; });
  rows.forEach(r => { byUnit[r._id.unitKey][r._id.status] = r.n; });
  const [inbox, approvedUnprinted] = await Promise.all([
    Record.countDocuments({ status: 'pending', slots: { $elemMatch: { approvers: req.user._id, 'signatures.user': { $ne: req.user._id } } } }),
    Record.countDocuments({ status: 'final', submittedBy: req.user._id, printCount: 0 })
  ]);
  res.json({ byUnit, inbox, approvedUnprinted });
}));

// ── One record ──
router.get('/:id', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (!canView(req.user, rec)) throw new HttpError(403, 'You do not have access to this record.');
  await rec.populate(POPULATE);
  res.json({ record: serialize(rec) });
}));

// Everything the print engine needs: data, signatures, seal and QR.
router.get('/:id/document', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (!canView(req.user, rec)) throw new HttpError(403, 'You do not have access to this record.');
  await rec.populate(POPULATE);
  const unit = await Unit.findOne({ key: rec.unitKey });
  const out = serialize(rec);
  out.unitName = unit ? unit.name : rec.unitKey;
  out.signatures = [];
  rec.slots.forEach((s, i) => s.signatures.forEach((g, j) => out.signatures.push({
    label: s.label, role: s.role, name: g.name, title: g.title, signedAt: g.signedAt,
    imageUrl: `/api/records/${rec._id}/signatures/${i}/${j}`
  })));
  if (rec.status === 'final' || rec.status === 'revoked') {
    out.qrDataUrl = await verification.qrDataUrl(rec.verifyUrl);
  }
  res.json({ document: out });
}));

router.get('/:id/signatures/:slot/:idx', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (!canView(req.user, rec)) throw new HttpError(403, 'You do not have access to this record.');
  const slot = rec.slots[parseInt(req.params.slot, 10)];
  const sig = slot && slot.signatures[parseInt(req.params.idx, 10)];
  if (!sig) throw new HttpError(404, 'Signature not found.');
  const img = await store.read(sig.image);
  if (!img) throw new HttpError(404, 'Signature image missing.');
  res.set('Content-Type', img.contentType).set('Cache-Control', 'private, max-age=86400').send(img.buffer);
}));

// The saved copy of the signed document, as a standalone file.
router.get('/:id/copy', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (!canView(req.user, rec)) throw new HttpError(403, 'You do not have access to this record.');
  if (!['final', 'revoked'].includes(rec.status)) throw new HttpError(409, 'Only signed documents have a saved copy.');
  const html = await documentCopy.get(rec);
  // Printing fetches the copy too; the print itself is logged by /printed.
  if (!req.query.print) await audit.log(req, 'copy_downloaded', { record: rec });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${documentCopy.fileName(rec)}"`);
  res.set('Cache-Control', 'private, no-store');
  res.send(html);
}));

router.get('/:id/history', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (!canView(req.user, rec)) throw new HttpError(403, 'You do not have access to this record.');
  const { AuditLog } = require('../models');
  const entries = await AuditLog.find({ record: rec._id }).sort({ at: 1 }).select('at username action details');
  res.json({ entries });
}));

// ── Drafts ──
router.post('/', wrap(async (req, res) => {
  const unitKey = String(req.body.unitKey || '');
  const formType = String(req.body.formType || '');
  const unit = await Unit.findOne({ key: unitKey, active: true });
  if (!unit) throw new HttpError(404, 'Unit not found.');
  if (!canAccessUnit(req.user, unitKey) || !can(req.user, 'create')) throw new HttpError(403, 'You do not have permission to create records here.');
  if (!catalogue.formsForUnit(unit).includes(formType)) throw new HttpError(400, 'This form is not available to this unit.');
  const { data, error } = catalogue.cleanData(formType, req.body.data);
  if (error) throw new HttpError(400, error);
  const rec = new Record({
    unitKey, formType, data, ...catalogue.describe(formType, data),
    createdBy: req.user._id, createdByName: req.user.fullName, updatedBy: req.user._id
  });
  await saveRecord(rec);
  await audit.log(req, 'record_created', { record: rec });
  res.status(201).json({ record: serialize(rec) });
}));

router.put('/:id', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  const own = same(rec.createdBy, req.user._id) && can(req.user, 'create');
  if (!own) assertUnitAction(req.user, rec, 'edit');
  if (!canAccessUnit(req.user, rec.unitKey)) throw new HttpError(403, 'You do not have permission to do that.');
  assertEditable(rec);
  if (req.body.version !== undefined && Number(req.body.version) !== rec.__v) {
    throw new HttpError(409, 'This record was changed by someone else. Reload it before saving.');
  }
  const { data, error } = catalogue.cleanData(rec.formType, req.body.data);
  if (error) throw new HttpError(400, error);
  rec.data = data;
  Object.assign(rec, catalogue.describe(rec.formType, data));
  rec.updatedBy = req.user._id;
  rec.markModified('data');
  await saveRecord(rec);
  await audit.log(req, 'record_updated', { record: rec });
  res.json({ record: serialize(rec) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  assertUnitAction(req.user, rec, 'delete');
  if (!['draft', 'returned'].includes(rec.status)) {
    throw new HttpError(409, 'Only drafts can be deleted. A signed record can be revoked, not deleted.');
  }
  await audit.log(req, 'record_deleted', { record: rec, details: { formType: rec.formType, ref: rec.ref } });
  await rec.deleteOne();
  res.json({ ok: true });
}));

// ── Workflow ──
// body: { approvers: [[userId, ...] per signature line], rules: ['any'|'all' per line], pin }
router.post('/:id/submit', signLimiter, wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  assertUnitAction(req.user, rec, 'finalize');
  assertEditable(rec);

  const cfg = await FormConfig.findOne({ formType: rec.formType });
  const lines = cfg ? cfg.signers : [];
  const approvers = Array.isArray(req.body.approvers) ? req.body.approvers : [];
  const rules = Array.isArray(req.body.rules) ? req.body.rules : [];

  const slots = [];
  let selfSign = false;
  for (let i = 0; i < lines.length; i++) {
    const { role, label } = lines[i];
    if (req.user.signerRoles.includes(role)) {
      slots.push({ role, label, rule: 'any', approvers: [req.user._id], signatures: [] });
      selfSign = true;
      continue;
    }
    const ids = [...new Set((approvers[i] || []).map(String))];
    if (!ids.length) throw new HttpError(400, `Choose who should sign as ${label}.`);
    if (ids.some(id => !mongoose.isValidObjectId(id))) throw new HttpError(400, 'Invalid signer selected.');
    const users = await User.find({ _id: { $in: ids }, active: true, signerRoles: role });
    if (users.length !== ids.length) throw new HttpError(400, `Everyone chosen to sign as ${label} must hold that signing role.`);
    const rule = rules[i] === 'all' ? 'all' : 'any';
    slots.push({ role, label, rule, approvers: users.map(u => u._id), signatures: [] });
  }

  if (selfSign) {
    requireReadyToSign(req.user);
    await verifyPin(req.user, req.body.pin);
  }

  rec.slots = slots;
  if (selfSign) rec.slots.forEach(s => { if (s.approvers.length === 1 && same(s.approvers[0], req.user._id) && req.user.signerRoles.includes(s.role)) s.signatures.push(signatureFor(req.user)); });
  rec.submittedBy = req.user._id;
  rec.submittedByName = req.user.fullName;
  rec.submittedAt = new Date();
  rec.returnComment = undefined; rec.returnedBy = undefined; rec.returnedAt = undefined;

  if (allDone(rec)) {
    await finalize(req, rec);
    await saveRecord(rec);
    await documentCopy.save(rec);
    await audit.log(req, 'record_finalized', { record: rec, details: { verifyCode: rec.verifyCode, selfSigned: selfSign } });
  } else {
    rec.status = 'pending';
    await saveRecord(rec);
    const waiting = rec.slots.filter(s => !slotDone(s)).flatMap(s => s.approvers);
    await notify(waiting, 'submitted', rec, `${catalogue.get(rec.formType).label} ${rec.ref || ''} is waiting for your signature.`.trim(), req);
    await audit.log(req, 'record_submitted', { record: rec, details: { slots: rec.slots.map(s => ({ label: s.label, rule: s.rule, approvers: s.approvers.map(String) })) } });
  }
  await rec.populate(POPULATE);
  res.json({ record: serialize(rec) });
}));

router.post('/:id/approve', signLimiter, wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (rec.status !== 'pending') throw new HttpError(409, 'This record is not awaiting signature.');
  const mySlots = rec.slots.filter(s => !slotDone(s) &&
    s.approvers.some(a => same(a, req.user._id)) && !s.signatures.some(g => same(g.user, req.user._id)));
  if (!mySlots.length) throw new HttpError(403, 'This record is not waiting for your signature.');
  requireReadyToSign(req.user);
  await verifyPin(req.user, req.body.pin);

  mySlots.forEach(s => s.signatures.push(signatureFor(req.user)));
  const complete = allDone(rec);
  if (complete) await finalize(req, rec);
  await saveRecord(rec);
  if (complete) await documentCopy.save(rec);
  await audit.log(req, complete ? 'record_approved' : 'record_signed', { record: rec, details: { lines: mySlots.map(s => s.label), verifyCode: rec.verifyCode } });

  const label = catalogue.get(rec.formType).label;
  if (complete) {
    await notify(rec.submittedBy, 'approved', rec, `${label} ${rec.ref || ''} has been approved and signed. It is ready to print.`.trim(), req);
  } else {
    await notify(rec.submittedBy, 'signed', rec, `${req.user.fullName} signed ${label} ${rec.ref || ''}. Waiting for the remaining signatures.`.trim(), req);
  }
  await rec.populate(POPULATE);
  res.json({ record: serialize(rec) });
}));

router.post('/:id/return', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (rec.status !== 'pending') throw new HttpError(409, 'Only records awaiting signature can be returned.');
  if (!isApprover(rec, req.user) && !isAdmin(req.user)) throw new HttpError(403, 'Only a signer on this record can return it.');
  const comment = String(req.body.comment || '').trim().slice(0, 2000);
  if (!comment) throw new HttpError(400, 'Please say what needs correcting.');
  rec.status = 'returned';
  rec.slots.forEach(s => { s.signatures = []; }); // content will change; earlier signatures no longer apply
  rec.returnComment = comment;
  rec.returnedBy = req.user.fullName;
  rec.returnedAt = new Date();
  await saveRecord(rec);
  await audit.log(req, 'record_returned', { record: rec, details: { comment } });
  await notify(rec.submittedBy, 'returned', rec, `${catalogue.get(rec.formType).label} ${rec.ref || ''} was returned by ${req.user.fullName}: ${comment}`, req);
  res.json({ record: serialize(rec) });
}));

// The submitter pulls a pending record back to correct it.
router.post('/:id/withdraw', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (rec.status !== 'pending') throw new HttpError(409, 'Only records awaiting signature can be withdrawn.');
  if (!same(rec.submittedBy, req.user._id)) assertUnitAction(req.user, rec, 'finalize');
  rec.status = 'draft';
  rec.slots.forEach(s => { s.signatures = []; });
  await saveRecord(rec);
  await audit.log(req, 'record_withdrawn', { record: rec });
  res.json({ record: serialize(rec) });
}));

router.post('/:id/revoke', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (rec.status !== 'final') throw new HttpError(409, 'Only signed records can be revoked.');
  const signedIt = rec.slots.some(s => s.signatures.some(g => same(g.user, req.user._id)));
  if (!signedIt && !isAdmin(req.user)) throw new HttpError(403, 'Only a signer of this record or an administrator can revoke it.');
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  if (!reason) throw new HttpError(400, 'Please give the reason for revoking.');
  rec.status = 'revoked';
  rec.revokedAt = new Date();
  rec.revokedBy = req.user.fullName;
  rec.revokeReason = reason;
  await saveRecord(rec);
  await audit.log(req, 'record_revoked', { record: rec, details: { reason } });
  await notify(rec.submittedBy, 'revoked', rec, `${catalogue.get(rec.formType).label} ${rec.ref || ''} was revoked: ${reason}`, req);
  res.json({ record: serialize(rec) });
}));

router.post('/:id/printed', wrap(async (req, res) => {
  const rec = await loadRecord(req.params.id);
  if (!same(rec.submittedBy, req.user._id)) assertUnitAction(req.user, rec, 'print');
  if (rec.status !== 'final') throw new HttpError(409, 'Only signed records can be printed as official copies.');
  rec.printCount += 1;
  if (!rec.firstPrintedAt) rec.firstPrintedAt = new Date();
  await saveRecord(rec);
  await audit.log(req, 'record_printed', { record: rec, details: { copy: rec.printCount } });
  res.json({ record: serialize(rec, false) });
}));

module.exports = router;

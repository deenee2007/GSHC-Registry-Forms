/*
 * src/routes/admin.js — Settings: users, units, form access and signing
 * rules, and the audit log. Administrators only.
 */
const express = require('express');
const mongoose = require('mongoose');
const { User, Unit, FormConfig, AuditLog, PRIVILEGES } = require('../models');
const { SIGNER_ROLES } = require('../forms/signers');
const catalogue = require('../forms/catalogue');
const pw = require('../services/passwords');
const audit = require('../services/audit');
const { HttpError, requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin, requireAdmin);

const oid = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Not found.');
  return id;
};

async function cleanUserInput(body, units) {
  const out = {};
  if (body.fullName !== undefined) {
    out.fullName = String(body.fullName).trim();
    if (!out.fullName) throw new HttpError(400, 'Full name is required.');
  }
  if (body.title !== undefined) out.title = String(body.title).trim().slice(0, 80);
  if (body.role !== undefined) {
    if (!['admin', 'user'].includes(body.role)) throw new HttpError(400, 'Invalid role.');
    out.role = body.role;
  }
  if (body.unitKeys !== undefined) {
    const keys = new Set(units.map(u => u.key));
    out.unitKeys = [...new Set((body.unitKeys || []).map(String))];
    if (out.unitKeys.some(k => !keys.has(k))) throw new HttpError(400, 'Unknown unit.');
  }
  if (body.privileges !== undefined) {
    out.privileges = [...new Set((body.privileges || []).map(String))];
    if (out.privileges.some(p => !PRIVILEGES.includes(p))) throw new HttpError(400, 'Invalid privilege.');
  }
  if (body.signerRoles !== undefined) {
    out.signerRoles = [...new Set((body.signerRoles || []).map(String))];
    if (out.signerRoles.some(r => !SIGNER_ROLES[r])) throw new HttpError(400, 'Invalid signing role.');
  }
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

// ── Reference data for the Settings screens ──
router.get('/meta', (req, res) => {
  res.json({ privileges: PRIVILEGES, signerRoles: SIGNER_ROLES });
});

// ── Users ──
router.get('/users', wrap(async (req, res) => {
  const users = await User.find().sort({ fullName: 1 });
  res.json({ users: users.map(u => u.toSafeJSON()) });
}));

router.post('/users', wrap(async (req, res) => {
  const units = await Unit.find();
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username must be 3 to 40 letters, numbers, dots or underscores.');
  if (await User.exists({ username })) throw new HttpError(409, 'That username is already taken.');
  const fields = await cleanUserInput(req.body, units);
  if (!fields.fullName) throw new HttpError(400, 'Full name is required.');
  const tempPassword = pw.temporaryPassword();
  const user = await User.create({ ...fields, username, passwordHash: await pw.hash(tempPassword), mustChangePassword: true });
  await audit.log(req, 'user_created', { details: { username } });
  res.status(201).json({ user: user.toSafeJSON(), tempPassword });
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const user = await User.findById(oid(req.params.id));
  if (!user) throw new HttpError(404, 'User not found.');
  const fields = await cleanUserInput(req.body, await Unit.find());
  if (String(user._id) === String(req.user._id) && (fields.role === 'user' || fields.active === false)) {
    throw new HttpError(400, 'You cannot remove your own administrator access.');
  }
  Object.assign(user, fields);
  await user.save();
  await audit.log(req, 'user_updated', { details: { username: user.username, fields: Object.keys(fields) } });
  res.json({ user: user.toSafeJSON() });
}));

router.post('/users/:id/reset-password', wrap(async (req, res) => {
  const user = await User.findById(oid(req.params.id));
  if (!user) throw new HttpError(404, 'User not found.');
  const tempPassword = pw.temporaryPassword();
  user.passwordHash = await pw.hash(tempPassword);
  user.mustChangePassword = true; user.failedLogins = 0; user.lockedUntil = null;
  await user.save();
  await audit.log(req, 'password_reset', { details: { username: user.username } });
  res.json({ user: user.toSafeJSON(), tempPassword });
}));

router.post('/users/:id/reset-pin', wrap(async (req, res) => {
  const user = await User.findById(oid(req.params.id));
  if (!user) throw new HttpError(404, 'User not found.');
  user.signingPinHash = null; user.pinFailures = 0; user.pinLockedUntil = null;
  await user.save();
  await audit.log(req, 'signing_pin_reset', { details: { username: user.username } });
  res.json({ user: user.toSafeJSON() });
}));

// Accounts are deactivated, never deleted: signed documents and the audit
// log still point at them.
router.delete('/users/:id', wrap(async (req, res) => {
  const user = await User.findById(oid(req.params.id));
  if (!user) throw new HttpError(404, 'User not found.');
  if (String(user._id) === String(req.user._id)) throw new HttpError(400, 'You cannot deactivate your own account.');
  user.active = false;
  await user.save();
  await audit.log(req, 'user_deactivated', { details: { username: user.username } });
  res.json({ user: user.toSafeJSON() });
}));

// ── Units ──
router.post('/units', wrap(async (req, res) => {
  const type = req.body.type || 'registry';
  if (!catalogue.MODULES[type]) throw new HttpError(400, 'Invalid unit type.');
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Unit name is required.');
  let key = String(req.body.key || '').trim().toLowerCase();
  let courtNo;
  if (!key && type === 'registry') {
    const nums = (await Unit.find({ type: 'registry' })).map(u => u.courtNo || 0);
    courtNo = Math.max(0, ...nums) + 1;
    key = 'hc' + courtNo;
  }
  if (!/^[a-z0-9_-]{2,30}$/.test(key)) throw new HttpError(400, 'Unit key must be 2 to 30 letters or numbers.');
  if (await Unit.exists({ key })) throw new HttpError(409, 'A unit with that key already exists.');
  const unit = await Unit.create({ key, type, name, courtNo });
  await audit.log(req, 'unit_created', { unitKey: key });
  res.status(201).json({ unit });
}));

router.patch('/units/:key', wrap(async (req, res) => {
  const unit = await Unit.findOne({ key: req.params.key });
  if (!unit) throw new HttpError(404, 'Unit not found.');
  if (req.body.name !== undefined) unit.name = String(req.body.name).trim() || unit.name;
  if (req.body.active !== undefined) unit.active = !!req.body.active;
  if (req.body.allowedForms !== undefined) {
    if (req.body.allowedForms === null) unit.allowedForms = null;
    else {
      const forms = [...new Set((req.body.allowedForms || []).map(String))];
      if (!forms.length) throw new HttpError(400, 'Select at least one form.');
      if (forms.some(f => !catalogue.forms[f])) throw new HttpError(400, 'Unknown form.');
      unit.allowedForms = forms;
    }
  }
  await unit.save();
  await audit.log(req, 'unit_updated', { unitKey: unit.key });
  res.json({ unit });
}));

// ── Signing rules per form ──
router.put('/forms/:formType/signers', wrap(async (req, res) => {
  const { formType } = req.params;
  if (!catalogue.forms[formType]) throw new HttpError(404, 'Unknown form.');
  const signers = (req.body.signers || []).map(s => ({
    role: String(s.role || ''),
    label: String(s.label || SIGNER_ROLES[s.role] || '').trim().slice(0, 80)
  }));
  if (signers.length > 4) throw new HttpError(400, 'A form can have at most 4 signature lines.');
  if (signers.some(s => !SIGNER_ROLES[s.role] || !s.label)) throw new HttpError(400, 'Each signature line needs a valid role and label.');
  const cfg = await FormConfig.findOneAndUpdate({ formType }, { signers }, { new: true, upsert: true });
  await audit.log(req, 'form_signers_updated', { details: { formType, signers } });
  res.json({ formType, signers: cfg.signers });
}));

// ── Audit log ──
router.get('/audit', wrap(async (req, res) => {
  const q = {};
  if (req.query.action) q.action = String(req.query.action);
  if (req.query.username) q.username = String(req.query.username).toLowerCase();
  if (req.query.record && mongoose.isValidObjectId(req.query.record)) q.record = req.query.record;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const entries = await AuditLog.find(q).sort({ at: -1 }).limit(limit);
  res.json({ entries });
}));

module.exports = router;

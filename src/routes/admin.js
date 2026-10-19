/*
 * src/routes/admin.js — Settings: users, units, form access and signing
 * rules, backups and the audit log. Administrators only.
 */
const express = require('express');
const mongoose = require('mongoose');
const { User, Unit, FormConfig, AuditLog, PRIVILEGES } = require('../models');
const { SIGNER_ROLES } = require('../forms/signers');
const catalogue = require('../forms/catalogue');
const pw = require('../services/passwords');
const mail = require('../services/mail');
const links = require('../services/passwordLinks');
const settings = require('../services/settings');
const audit = require('../services/audit');
const config = require('../config');
const backup = require('../services/backup');
const { HttpError, requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin, requireAdmin);

const oid = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Not found.');
  return id;
};

// A username is either an email address or a short name (letters, numbers,
// dots, dashes, underscores) for staff who have no email.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validUsername = (u) => /^[a-z0-9._-]{3,40}$/.test(u) || (EMAIL.test(u) && u.length <= 120);

async function cleanUserInput(body, units) {
  const out = {};
  if (body.fullName !== undefined) {
    out.fullName = String(body.fullName).trim();
    if (!out.fullName) throw new HttpError(400, 'Full name is required.');
  }
  if (body.title !== undefined) out.title = String(body.title).trim().slice(0, 80);
  if (body.email !== undefined) {
    const email = String(body.email || '').trim().toLowerCase();
    if (email && !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    out.email = email || undefined;
  }
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
  if (body.emailAlertsBlocked !== undefined) out.emailAlertsBlocked = !!body.emailAlertsBlocked;
  return out;
}

// ── Reference data for the Settings screens ──
router.get('/meta', wrap(async (req, res) => {
  res.json({ privileges: PRIVILEGES, signerRoles: SIGNER_ROLES, mailEnabled: mail.enabled(), settings: await settings.get() });
}));

// System wide switches, e.g. { emailAlerts: false } stops alert emails for everyone.
router.put('/settings', wrap(async (req, res) => {
  const out = await settings.set(req.body || {});
  await audit.log(req, 'settings_updated', { details: req.body });
  res.json({ settings: out });
}));

// ── Users ──
router.get('/users', wrap(async (req, res) => {
  const users = await User.find().sort({ fullName: 1 });
  res.json({ users: users.map(u => u.toSafeJSON()) });
}));

router.post('/users', wrap(async (req, res) => {
  const units = await Unit.find();
  const fields = await cleanUserInput(req.body, units);
  // With an email address, the email is the username unless one is given.
  const username = (String(req.body.username || '').trim() || fields.email || '').toLowerCase();
  if (!username) throw new HttpError(400, 'Enter the email address, or a username for staff without email.');
  if (!validUsername(username)) throw new HttpError(400, 'Username must be an email address, or 3 to 40 letters, numbers, dots or underscores.');
  if (await User.exists({ $or: [{ username }, { email: username }] })) throw new HttpError(409, 'That username or email is already taken.');
  if (!fields.fullName) throw new HttpError(400, 'Full name is required.');
  if (fields.email && await User.exists({ email: fields.email })) throw new HttpError(409, 'Another account already uses that email address.');
  const invite = !!req.body.sendInvite && !!fields.email && mail.enabled();
  // An invited user chooses their own password from the email link, so the
  // stored one is random and never shown to anyone.
  const tempPassword = invite ? null : pw.temporaryPassword();
  const user = await User.create({
    ...fields, username,
    passwordHash: await pw.hash(tempPassword || require('crypto').randomBytes(24).toString('base64url')),
    mustChangePassword: true
  });
  await audit.log(req, 'user_created', { details: { username, invited: invite } });
  if (invite) {
    try {
      await links.sendLink(req, user, 'invite');
      await audit.log(req, 'invite_sent', { details: { username } });
    } catch (e) {
      // Account exists; fall back to a one time password the admin can hand over.
      const fallback = pw.temporaryPassword();
      user.passwordHash = await pw.hash(fallback);
      await user.save();
      return res.status(201).json({ user: user.toSafeJSON(), tempPassword: fallback, emailError: e.message });
    }
    return res.status(201).json({ user: user.toSafeJSON(), invited: true });
  }
  res.status(201).json({ user: user.toSafeJSON(), tempPassword });
}));

// Email a link to choose a new password (an invitation if they never signed in).
router.post('/users/:id/send-link', wrap(async (req, res) => {
  const user = await User.findById(oid(req.params.id));
  if (!user) throw new HttpError(404, 'User not found.');
  if (!user.active) throw new HttpError(400, 'Activate the account first.');
  if (!mail.enabled()) throw new HttpError(503, 'Email is not set up on this server.');
  const kind = user.lastLoginAt ? 'reset' : 'invite';
  await links.sendLink(req, user, kind);
  await audit.log(req, kind === 'invite' ? 'invite_sent' : 'password_reset_link_sent', { details: { username: user.username } });
  res.json({ ok: true, email: user.email, kind });
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const user = await User.findById(oid(req.params.id));
  if (!user) throw new HttpError(404, 'User not found.');
  const fields = await cleanUserInput(req.body, await Unit.find());
  if (fields.email && await User.exists({ $or: [{ email: fields.email }, { username: fields.email }], _id: { $ne: user._id } })) {
    throw new HttpError(409, 'Another account already uses that email address.');
  }
  // Signing in by email: when the email changes, or is added for a user
  // who had none, the username follows it (not the built in admin account,
  // which the Render recovery looks for by name).
  if (fields.email && fields.email !== user.email && user.username !== config.adminUsername &&
      (!user.email || user.username === user.email)) {
    fields.username = fields.email;
  }
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
  await links.endSessions(user._id);
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
// New units are either another Court Registry (numbered automatically,
// with the registry forms) or an "Other Unit" (Probate, Accounts, Open
// Registry, ...) whose forms the admin picks under Form Access. Appeals and
// Execution exist once each and are not added here.
router.post('/units', wrap(async (req, res) => {
  const type = req.body.type || 'registry';
  if (!['registry', 'general'].includes(type)) throw new HttpError(400, 'Choose Court Registry or Other Unit.');
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Unit name is required.');
  let key, courtNo;
  if (type === 'registry') {
    const nums = (await Unit.find({ type: 'registry' })).map(u => u.courtNo || 0);
    courtNo = Math.max(0, ...nums) + 1;
    key = 'hc' + courtNo;
  } else {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'unit';
    key = base;
    for (let i = 2; await Unit.exists({ key }); i++) key = `${base}_${i}`;
  }
  if (await Unit.exists({ key })) throw new HttpError(409, 'A unit with that key already exists.');
  let allowedForms = null;
  if (Array.isArray(req.body.allowedForms) && req.body.allowedForms.length) {
    allowedForms = [...new Set(req.body.allowedForms.map(String))];
    if (allowedForms.some(f => !catalogue.forms[f])) throw new HttpError(400, 'Unknown form.');
  }
  const unit = await Unit.create({ key, type, name, courtNo, allowedForms });
  await audit.log(req, 'unit_created', { unitKey: key, details: { type, name } });
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

// ── Overview and backup ──
router.get('/stats', wrap(async (req, res) => {
  const { Record } = require('../models');
  const [users, activeUsers, signers, units, byStatus] = await Promise.all([
    User.countDocuments(), User.countDocuments({ active: true }),
    User.countDocuments({ active: true, 'signerRoles.0': { $exists: true } }),
    Unit.countDocuments({ active: true }),
    Record.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
  ]);
  res.json({ users, activeUsers, signers, units, records: Object.fromEntries(byStatus.map(r => [r._id, r.n])) });
}));

// Full JSON backup of records (signature images are not included; they
// stay in Cloudinary). Atlas also keeps its own automatic backups.
router.get('/export', wrap(async (req, res) => {
  const { Record } = require('../models');
  await audit.log(req, 'backup_exported');
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="gshc_records_${new Date().toISOString().slice(0, 10)}.json"`);
  res.write('[');
  let first = true;
  for await (const r of Record.find().sort({ createdAt: 1 }).select('-slots.signatures.image').lean().cursor()) {
    res.write((first ? '' : ',') + JSON.stringify(r));
    first = false;
  }
  res.end(']');
}));

// ── Automatic backups ──
router.get('/backups', wrap(async (req, res) => {
  const { Backup, DocumentCopy } = require('../models');
  const [backups, copies, copiesSaved] = await Promise.all([
    Backup.find({ deleted: false }).sort({ at: -1 }).limit(40).lean(),
    DocumentCopy.countDocuments(), DocumentCopy.countDocuments({ backedUpAt: { $exists: true } })
  ]);
  res.json({ ...backup.status(), copies, copiesSaved,
    backups: backups.map(b => ({ id: b._id, at: b.at, ok: b.ok, reason: b.reason, by: b.by, bytes: b.bytes,
      records: b.counts ? b.counts.records : undefined, copiesAdded: b.copiesAdded, error: b.error })) });
}));

router.post('/backups', wrap(async (req, res) => {
  let entry;
  try { entry = await backup.run({ reason: 'manual', by: req.user.username }); }
  catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: true }); }
  await audit.log(req, 'backup_run', { details: { file: entry.file } });
  res.status(201).json({ backup: { id: entry._id, at: entry.at, ok: entry.ok, bytes: entry.bytes, copiesAdded: entry.copiesAdded } });
}));

router.get('/backups/:id/download', wrap(async (req, res) => {
  const { Backup } = require('../models');
  const entry = await Backup.findOne({ _id: oid(req.params.id), ok: true, deleted: false });
  if (!entry) throw new HttpError(404, 'That backup is no longer kept.');
  let buffer;
  try { buffer = await backup.read(entry); }
  catch (e) { throw Object.assign(new HttpError(e.status || 502, e.message), { expose: true }); }
  await audit.log(req, 'backup_downloaded', { details: { file: entry.file } });
  res.set('Content-Type', 'application/gzip');
  res.set('Content-Disposition', `attachment; filename="${entry.file.split('/').pop()}"`);
  res.set('Cache-Control', 'private, no-store');
  res.send(buffer);
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

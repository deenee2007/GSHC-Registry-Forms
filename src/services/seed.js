/*
 * src/services/seed.js — first run setup: units, form signing rules and
 * the first admin account. Safe to run on every start; it only fills gaps.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const catalogue = require('../forms/catalogue');
const { DEFAULT_SIGNERS, RULE_UPDATES, RETIRED_ROLES } = require('../forms/signers');
const mongoose = require('mongoose');
const { User, Unit, FormConfig, AuditLog } = require('../models');

const SEED_UNITS = [
  ...Array.from({ length: 9 }, (_, i) => ({ key: 'hc' + (i + 1), type: 'registry', name: `High Court ${i + 1} Registry`, courtNo: i + 1 })),
  { key: 'appeals', type: 'appeals', name: 'Appeals Registry' },
  { key: 'execution', type: 'execution', name: 'Execution / Bailiffs Unit' }
];

async function seedUnits() {
  if (await Unit.countDocuments() === 0) await Unit.insertMany(SEED_UNITS);
  // Added later: databases made before it get it too.
  if (!(await Unit.exists({ type: 'process' }))) await Unit.create({ key: 'process', type: 'process', name: 'Process Registry' });
  if (!(await Unit.exists({ type: 'marriage' }))) await Unit.create({ key: 'marriage', type: 'marriage', name: 'Marriage Registry' });
  if (!(await Unit.exists({ type: 'personnel' }))) await Unit.create({ key: 'personnel', type: 'personnel', name: 'Directorate of Personnel' });
}

// The roll became the Directorate of Personnel unit: those who already had
// the roll's privileges are given the unit once, so nobody loses it. One with
// no unit (who reached every unit) keeps every unit, with this one added.
// Records linked to a sign in account before personal accounts existed were
// linked to a work account: that link becomes the record's work account.
async function workLinksOnce(log = console.log) {
  const meta = mongoose.connection.collection('appmeta');
  if (await meta.findOne({ _id: 'staffWorkLinks-2026-11' })) return;
  const { Staff } = require('../models');
  let n = 0;
  for (const s of await Staff.find({ user: { $ne: null } }, 'user workUser')) {
    const u = await User.findById(s.user, 'kind').lean();
    if (u && u.kind !== 'personal') { await Staff.updateOne({ _id: s._id }, { $set: { workUser: s.user, user: null } }); n++; }
  }
  if (n) log(`  Nominal Roll: ${n} record(s) linked to a work account, now kept as the work account.`);
  await meta.updateOne({ _id: 'staffWorkLinks-2026-11' }, { $set: { at: new Date() } }, { upsert: true });
}

async function personnelUnitOnce(log = console.log) {
  const meta = mongoose.connection.collection('appmeta');
  if (await meta.findOne({ _id: 'personnelUnit-2026-11' })) return;
  const all = (await Unit.find({}, 'key').lean()).map(u => u.key);
  let n = 0;
  for (const u of await User.find({ role: { $ne: 'admin' }, privileges: { $in: ['personnel_view', 'personnel_edit'] }, unitKeys: { $ne: 'personnel' } })) {
    u.unitKeys = u.unitKeys.length ? [...u.unitKeys, 'personnel'] : all;
    await u.save(); n++;
  }
  if (n) log(`  Directorate of Personnel: given to ${n} user(s) who had the Nominal Roll.`);
  await meta.updateOne({ _id: 'personnelUnit-2026-11' }, { $set: { at: new Date() } }, { upsert: true });
}

// Add a signing rule for any form that does not have one yet. Existing
// rules are never overwritten: the admin owns them after first run.
async function seedFormConfigs() {
  const existing = new Set((await FormConfig.find({}, 'formType')).map(f => f.formType));
  const missing = Object.keys(catalogue.forms).filter(k => !existing.has(k));
  if (missing.length) {
    await FormConfig.insertMany(missing.map(formType => ({ formType, signers: DEFAULT_SIGNERS[formType] || [] })));
  }
}

// A retired signing role: its holders get the role that replaces it, and
// it leaves every signing rule. Signed documents keep their lines as signed.
async function retireRoles(log = console.log) {
  for (const [old, to] of Object.entries(RETIRED_ROLES)) {
    const holders = await User.collection.countDocuments({ signerRoles: old });
    await User.collection.updateMany({ signerRoles: old }, { $addToSet: { signerRoles: to } });
    await User.collection.updateMany({ signerRoles: old }, { $pull: { signerRoles: old } });
    const rules = await FormConfig.collection.updateMany({ 'signers.role': old }, { $pull: { signers: { role: old } } });
    if (holders || rules.modifiedCount) {
      log(`  Signing role "${old}" retired: ${holders} user(s) moved to "${to}", ${rules.modifiedCount} signing rule(s) updated.`);
    }
  }
}

// Bring older databases up to a changed default rule (see RULE_UPDATES).
async function updateFormConfigs(log = console.log) {
  const meta = mongoose.connection.collection('appmeta');
  for (const u of RULE_UPDATES) {
    if (await meta.findOne({ _id: 'rule:' + u.id })) continue;
    const cfg = await FormConfig.findOne({ formType: u.formType });
    const roles = cfg ? cfg.signers.map(s => s.role) : [];
    if (cfg && roles.length === u.from.length && roles.every((r, i) => r === u.from[i])) {
      cfg.signers = DEFAULT_SIGNERS[u.formType];
      await cfg.save();
      log(`  Signing rule updated: ${u.formType} is now signed by ${cfg.signers.map(s => s.label).join(', ')}.`);
    }
    await meta.updateOne({ _id: 'rule:' + u.id }, { $set: { at: new Date() } }, { upsert: true });
  }
}

// Records saved before the case file and hearing reminders existed get
// their case numbers and court dates once.
async function fillCaseNumbers(log = console.log) {
  const { Record } = require('../models');
  let n = 0;
  for await (const r of Record.find({ $or: [{ caseNos: { $exists: false } }, { events: { $exists: false } }] }, 'formType data').lean().cursor()) {
    await Record.collection.updateOne({ _id: r._id }, { $set: { caseNos: catalogue.caseNumbers(r.formType, r.data), events: catalogue.courtDates(r.formType, r.data) } });
    n++;
  }
  if (n) log(`  Case numbers and court dates filled in for ${n} earlier record(s).`);
}

// Staff sign in with their email: once, every account that has an email
// address takes it as its username (the built in admin account keeps
// "admin", which ADMIN_RESET looks for; it can still sign in by email).
async function usernamesToEmail(log = console.log) {
  const meta = mongoose.connection.collection('appmeta');
  if (await meta.findOne({ _id: 'usernamesToEmail' })) return;
  let n = 0;
  for (const u of await User.find({ email: { $type: 'string' }, username: { $ne: config.adminUsername } })) {
    if (u.username === u.email) continue;
    if (await User.exists({ username: u.email, _id: { $ne: u._id } })) continue; // taken: keep the old username
    await User.collection.updateOne({ _id: u._id }, { $set: { username: u.email } });
    n++;
  }
  await meta.updateOne({ _id: 'usernamesToEmail' }, { $set: { at: new Date(), switched: n } }, { upsert: true });
  if (n) log(`  Sign in by email: ${n} account(s) now use their email address as username.`);
}

async function seedAdmin(log = console.log) {
  if (await User.countDocuments() > 0) return null;
  const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  await User.create({
    username: config.adminUsername,
    fullName: 'System Administrator',
    passwordHash: await bcrypt.hash(password, 12),
    role: 'admin',
    mustChangePassword: true
  });
  log('====================================================');
  log(`  First admin account created: ${config.adminUsername}`);
  log(config.adminPassword
    ? '  Password: the value of ADMIN_PASSWORD'
    : `  Temporary password: ${password}`);
  log('  You will be asked to change it at first sign in.');
  log('====================================================');
  return password;
}

// ADMIN_RESET=true: set the admin account's password to ADMIN_PASSWORD,
// unlock it and require a new password at next sign in. It runs once per
// ADMIN_PASSWORD value (a fingerprint is kept), so leaving the setting on by
// mistake cannot undo a password the admin chose later.
async function resetAdmin({ username = config.adminUsername, password = config.adminPassword, log = console.log } = {}) {
  if (!password) {
    log('ADMIN_RESET is set but ADMIN_PASSWORD is empty. Nothing was reset.');
    return 'no-password';
  }
  const meta = mongoose.connection.collection('appmeta');
  const fingerprint = crypto.createHash('sha256').update(`${username}\n${password}`).digest('hex');
  const done = await meta.findOne({ _id: 'adminReset' });
  if (done && done.fingerprint === fingerprint) {
    log('ADMIN_RESET was already applied for this ADMIN_PASSWORD. Remove ADMIN_RESET from the environment.');
    return 'already-done';
  }

  const passwordHash = await bcrypt.hash(password, 12);
  let user = await User.findOne({ username });
  if (user) {
    Object.assign(user, { passwordHash, role: 'admin', active: true, mustChangePassword: true, failedLogins: 0, lockedUntil: null });
    await user.save();
  } else {
    user = await User.create({ username, fullName: 'System Administrator', passwordHash, role: 'admin', mustChangePassword: true });
  }
  await meta.updateOne({ _id: 'adminReset' }, { $set: { fingerprint, at: new Date() } }, { upsert: true });
  await AuditLog.create({ action: 'admin_reset', username, details: { via: 'ADMIN_RESET' } });
  log('====================================================');
  log(`  ADMIN_RESET: the password of "${username}" was reset to ADMIN_PASSWORD`);
  log('  and the account unlocked. Sign in and choose a new password,');
  log('  then REMOVE ADMIN_RESET from the environment.');
  log('====================================================');
  return 'reset';
}

// What the log shows at every start, so a wrong database is obvious.
async function report(log = console.log) {
  const [users, admins, foreign] = await Promise.all([
    User.countDocuments(), User.countDocuments({ role: 'admin', active: true }),
    User.countDocuments({ signerRoles: { $exists: false } }) // every account this app makes has this field
  ]);
  log(`  Database: ${mongoose.connection.name}  ·  users: ${users}  ·  active administrators: ${admins}`);
  if (foreign > 0) {
    log(`  WARNING: ${foreign} account(s) in this database were not created by this app.`);
    log('  MONGODB_URI may point at another application\'s database. Give this app');
    log('  its own database name in MONGODB_URI (for example /GSHC_DB).');
  } else if (users > 0 && admins === 0) {
    log('  WARNING: this database has users but no active administrator. If it belongs to');
    log('  another application, point MONGODB_URI at this app\'s own database. To recover');
    log('  the admin account here, set ADMIN_RESET=true and restart.');
  }
}

// Receipt numbers saved before they were checked for use twice: written one
// way (RC 1001 and rc-1001 alike) so the check finds them.
async function fillReceiptKeys(log) {
  const { Case, receiptKey } = require('../models');
  const list = await Case.find({ receiptNumber: { $nin: ['', null] }, receiptKey: { $exists: false } }, 'receiptNumber').lean();
  for (const c of list) await Case.updateOne({ _id: c._id }, { $set: { receiptKey: receiptKey(c.receiptNumber) } });
  if (list.length) log(`Receipts: ${list.length} receipt number(s) indexed for the check against use twice.`);
}

async function seedAll(log = console.log) {
  await seedUnits();
  await seedFormConfigs();
  await personnelUnitOnce(log);
  await workLinksOnce(log);
  await retireRoles(log);
  await updateFormConfigs(log);
  await fillCaseNumbers(log);
  await usernamesToEmail(log);
  await fillReceiptKeys(log);
  await require('./process').undoOfficialFeesOnce(log);
  await require('./process').addRegisterTypesOnce(log);
  const created = await seedAdmin(log);
  if (config.adminReset) await resetAdmin({ log });
  return created;
}

module.exports = { workLinksOnce, personnelUnitOnce, seedAll, resetAdmin, report, updateFormConfigs, retireRoles, fillCaseNumbers, usernamesToEmail, SEED_UNITS };

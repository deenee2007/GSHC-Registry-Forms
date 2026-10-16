/*
 * src/services/seed.js — first run setup: units, form signing rules and
 * the first admin account. Safe to run on every start; it only fills gaps.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const catalogue = require('../forms/catalogue');
const { DEFAULT_SIGNERS } = require('../forms/signers');
const mongoose = require('mongoose');
const { User, Unit, FormConfig, AuditLog } = require('../models');

const SEED_UNITS = [
  ...Array.from({ length: 9 }, (_, i) => ({ key: 'hc' + (i + 1), type: 'registry', name: `High Court ${i + 1} Registry`, courtNo: i + 1 })),
  { key: 'appeals', type: 'appeals', name: 'Appeals Registry' },
  { key: 'execution', type: 'execution', name: 'Execution / Bailiffs Unit' }
];

async function seedUnits() {
  if (await Unit.countDocuments() > 0) return;
  await Unit.insertMany(SEED_UNITS);
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

async function seedAll(log = console.log) {
  await seedUnits();
  await seedFormConfigs();
  const created = await seedAdmin(log);
  if (config.adminReset) await resetAdmin({ log });
  return created;
}

module.exports = { seedAll, resetAdmin, report, SEED_UNITS };

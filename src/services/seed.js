/*
 * src/services/seed.js — first run setup: units, form signing rules and
 * the first admin account. Safe to run on every start; it only fills gaps.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const catalogue = require('../forms/catalogue');
const { DEFAULT_SIGNERS } = require('../forms/signers');
const { User, Unit, FormConfig } = require('../models');

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
  if (!config.adminPassword) {
    log('====================================================');
    log(`  First admin account created: ${config.adminUsername}`);
    log(`  Temporary password: ${password}`);
    log('  You will be asked to change it at first sign in.');
    log('====================================================');
  }
  return password;
}

async function seedAll(log) {
  await seedUnits();
  await seedFormConfigs();
  return seedAdmin(log);
}

module.exports = { seedAll, SEED_UNITS };

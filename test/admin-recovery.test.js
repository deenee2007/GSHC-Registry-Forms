/*
 * Tests for the startup safeguards: database name check, ADMIN_RESET and
 * the startup report.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
delete process.env.CLOUDINARY_URL;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_recovery';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { databaseName } = require('../src/config');
const { resetAdmin, report, updateFormConfigs, retireRoles } = require('../src/services/seed');
const { User, FormConfig } = require('../src/models');

before(async () => { await mongoose.connect(DB); await mongoose.connection.dropDatabase(); });
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('database name is read from the connection string', () => {
  assert.equal(databaseName('mongodb+srv://u:p@cluster0.abc.mongodb.net/GSHC_DB?retryWrites=true&w=majority'), 'GSHC_DB');
  assert.equal(databaseName('mongodb+srv://u:p@cluster0.abc.mongodb.net/GSHC_DB'), 'GSHC_DB');
  assert.equal(databaseName('mongodb://h1:27017,h2:27017/gshc?replicaSet=rs0'), 'gshc');
  assert.equal(databaseName('mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true'), '');
  assert.equal(databaseName('mongodb+srv://u:p@cluster0.abc.mongodb.net'), '');
});

test('ADMIN_RESET resets once per password and unlocks the account', async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  await User.create({ username: 'admin', fullName: 'Admin', role: 'admin', passwordHash: await bcrypt.hash('Forgotten1', 4),
    mustChangePassword: false, failedLogins: 3, lockedUntil: new Date(Date.now() + 600000) });

  assert.equal(await resetAdmin({ username: 'admin', password: '', log }), 'no-password');
  assert.equal(await resetAdmin({ username: 'admin', password: 'Recover123', log }), 'reset');
  let u = await User.findOne({ username: 'admin' });
  assert.ok(await bcrypt.compare('Recover123', u.passwordHash));
  assert.equal(u.mustChangePassword, true);
  assert.equal(u.lockedUntil, null);
  assert.equal(u.failedLogins, 0);

  // The admin then picks a new password; a restart with ADMIN_RESET still set must not undo it.
  u.passwordHash = await bcrypt.hash('Chosen456', 4);
  await u.save();
  assert.equal(await resetAdmin({ username: 'admin', password: 'Recover123', log }), 'already-done');
  u = await User.findOne({ username: 'admin' });
  assert.ok(await bcrypt.compare('Chosen456', u.passwordHash));

  // A different ADMIN_PASSWORD resets again.
  assert.equal(await resetAdmin({ username: 'admin', password: 'Another789', log }), 'reset');
});

test('ADMIN_RESET creates the admin account when it is missing', async () => {
  await User.deleteMany({});
  assert.equal(await resetAdmin({ username: 'admin', password: 'Fresh1234', log: () => {} }), 'reset');
  const u = await User.findOne({ username: 'admin' });
  assert.equal(u.role, 'admin');
});

test('startup report names the database and flags accounts from another app', async () => {
  let logs = [];
  await report(m => logs.push(m));
  assert.match(logs[0], /Database: gshc_registry_test_recovery .* users: 1 .* active administrators: 1/);
  assert.equal(logs.length, 1);

  await mongoose.connection.collection('users').insertOne({ username: 'cms_editor', password: 'x' });
  logs = [];
  await report(m => logs.push(m));
  assert.ok(logs.some(l => /not created by this app/.test(l)));
});

test('the public auction receipt rule gains the Chief Registrar once, unless the admin changed it', async () => {
  const old = [{ role: 'deputy_sheriff', label: 'Deputy Sheriff' }, { role: 'chief_bailiff', label: 'Chief Bailiff' }];
  await FormConfig.deleteMany({});
  await mongoose.connection.collection('appmeta').deleteMany({ _id: /^rule:/ });
  await FormConfig.create({ formType: 'public-auction-receipt', signers: old });
  await updateFormConfigs(() => {});
  let cfg = await FormConfig.findOne({ formType: 'public-auction-receipt' });
  assert.deepEqual(cfg.signers.map(s => s.role), ['deputy_sheriff', 'chief_bailiff', 'chief_registrar']);

  // The admin later goes back to two signers; a restart leaves that alone.
  cfg.signers = old; await cfg.save();
  await updateFormConfigs(() => {});
  cfg = await FormConfig.findOne({ formType: 'public-auction-receipt' });
  assert.equal(cfg.signers.length, 2);

  // A rule the admin had already changed is never replaced.
  await FormConfig.deleteMany({});
  await mongoose.connection.collection('appmeta').deleteMany({ _id: /^rule:/ });
  await FormConfig.create({ formType: 'public-auction-receipt', signers: [{ role: 'chief_bailiff', label: 'Chief Bailiff' }] });
  await updateFormConfigs(() => {});
  cfg = await FormConfig.findOne({ formType: 'public-auction-receipt' });
  assert.deepEqual(cfg.signers.map(s => s.role), ['chief_bailiff']);
});

test('the Director of Litigation role is retired: holders become Deputy Sheriff, rules drop it', async () => {
  await User.collection.insertOne({ username: 'dol', fullName: 'Director', role: 'user', signerRoles: ['director_of_litigation'], unitKeys: [], privileges: [] });
  await User.collection.insertOne({ username: 'both', fullName: 'Both', role: 'user', signerRoles: ['deputy_sheriff', 'director_of_litigation'], unitKeys: [], privileges: [] });
  await FormConfig.deleteMany({});
  await FormConfig.collection.insertOne({ formType: 'public-auction-receipt', signers: [
    { role: 'deputy_sheriff', label: 'Deputy Sheriff' }, { role: 'chief_bailiff', label: 'Chief Bailiff' },
    { role: 'chief_registrar', label: 'Chief Registrar' }, { role: 'director_of_litigation', label: 'Director of Litigation' }] });
  const logs = [];
  await retireRoles(m => logs.push(m));
  assert.deepEqual((await User.findOne({ username: 'dol' })).signerRoles, ['deputy_sheriff']);
  assert.deepEqual((await User.findOne({ username: 'both' })).signerRoles, ['deputy_sheriff']);
  const cfg = await FormConfig.findOne({ formType: 'public-auction-receipt' });
  assert.deepEqual(cfg.signers.map(s => s.role), ['deputy_sheriff', 'chief_bailiff', 'chief_registrar']);
  assert.ok(logs.some(l => /2 user\(s\) moved/.test(l)));
  // The users can be saved again: no role outside the list is left.
  await (await User.findOne({ username: 'dol' })).validate(['signerRoles']);
});

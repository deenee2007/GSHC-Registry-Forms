/*
 * The automatic daily backup: what it writes, signed copies, keeping
 * period, failures and their email, the lock, and restoring a backup.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gshc-backup-'));
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
process.env.BACKUP_DIR = DIR;
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_backup';
const DB2 = DB + '_restored';

const mongoose = require('mongoose');
const { BSON } = require('mongodb');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const backup = require('../src/services/backup');
const mail = require('../src/services/mail');
const { restore } = require('../scripts/restore-backup');
const { Backup, DocumentCopy, User } = require('../src/models');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let server, base;

function client() {
  let cookie = '';
  async function call(method, p, body) {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GSHC', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}) };
}
const admin = client();
const u = {};
async function makeUser(spec) {
  const r = await admin.post('/api/admin/users', spec);
  const c = client();
  await c.post('/api/auth/login', { username: spec.username, password: r.body.tempPassword });
  await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'Passw0rd123' });
  c.id = r.body.user.id;
  return c;
}
const summons = { suitNumber: 'GM/88/2026', plaintiff: 'A', plaintiffAddress: 'B', defendant: 'C', recipientName: 'C',
  recipientAddress: 'D', appearanceDate: '2026-11-02', appearanceTime: '9:00', timePeriod: 'forenoon', issueDate: '2026-10-16' };
async function signedSummons() {
  const r = await u.clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons });
  await u.clerk.post(`/api/records/${r.body.record.id}/submit`, { approvers: [[u.judge.id]] });
  await u.judge.post(`/api/records/${r.body.record.id}/approve`, { pin: '2468' });
  return r.body.record.id;
}
const readBackup = (file) => BSON.EJSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, file))).toString(), { relaxed: false });

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  const c2 = await mongoose.createConnection(DB2).asPromise(); await c2.dropDatabase(); await c2.close();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  await User.updateOne({ username: 'admin' }, { $set: { email: 'ict@example.com' } });
  u.judge = await makeUser({ username: 'judge1', fullName: 'Judge One', unitKeys: ['hc1'], signerRoles: ['judge'] });
  u.clerk = await makeUser({ username: 'clerk1', fullName: 'Clerk One', unitKeys: ['hc1'], privileges: ['view', 'create', 'edit', 'finalize', 'print'] });
  await u.judge.post('/api/me/signature', { password: 'Passw0rd123', dataUrl: PNG });
  await u.judge.post('/api/me/signing-pin', { password: 'Passw0rd123', pin: '2468' });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  const c2 = await mongoose.createConnection(DB2).asPromise(); await c2.dropDatabase(); await c2.close();
  await mongoose.disconnect();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('Back up now writes one data file and the signed copies; only administrators', async () => {
  const id = await signedSummons();
  assert.equal(await backup.due(), true, 'due when there is no backup yet');
  assert.equal((await u.clerk.post('/api/admin/backups')).status, 403);
  assert.equal((await u.clerk.get('/api/admin/backups')).status, 403);

  const r = await admin.post('/api/admin/backups');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.backup.copiesAdded, 1);
  const entry = await Backup.findById(r.body.backup.id);
  const data = readBackup(entry.file);
  assert.equal(data.app, 'gshc-registry');
  assert.equal(data.collections.records.length, 1);
  assert.equal(data.collections.users.length, 3);
  assert.ok(data.collections.records[0].createdAt instanceof Date, 'dates kept as dates');
  assert.ok(data.collections.users.every(x => x.passwordHash), 'password hashes kept, so a restore keeps everyone\'s sign in');
  assert.ok(!data.collections.appmeta.some(m => m._id === 'backupLock'));
  const copy = zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'copies', `${id}.html.gz`))).toString();
  assert.match(copy, /^<!DOCTYPE html>/);
  assert.ok(await DocumentCopy.exists({ record: id, backedUpAt: { $exists: true } }));
  assert.equal(await backup.due(), false, 'not due again the same day');

  const again = await admin.post('/api/admin/backups');
  assert.equal(again.body.backup.copiesAdded, 0, 'copies are backed up once');

  const list = await admin.get('/api/admin/backups');
  assert.equal(list.body.enabled, true);
  assert.equal(list.body.backups.length, 2);
  assert.equal(list.body.copiesSaved, 1);

  const dl = await admin.get(`/api/admin/backups/${entry._id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="gshc_.*\.json\.gz"/);
  assert.equal(BSON.EJSON.parse(zlib.gunzipSync(dl.body).toString()).app, 'gshc-registry');
});

test('backups older than the keeping period are removed, never the newest', async () => {
  await Backup.updateMany({}, { $set: { at: new Date(Date.now() - 40 * 86400000) } });
  const old = await Backup.find({ ok: true });
  const r = await admin.post('/api/admin/backups');
  assert.equal(r.status, 201);
  for (const b of old) {
    assert.equal(fs.existsSync(path.join(DIR, b.file)), false, 'old file removed');
    assert.equal((await Backup.findById(b._id)).deleted, true);
  }
  const kept = await Backup.findById(r.body.backup.id);
  assert.ok(fs.existsSync(path.join(DIR, kept.file)));

});

test('only one backup runs at a time', async () => {
  await mongoose.connection.collection('appmeta').updateOne({ _id: 'backupLock' }, { $set: { until: new Date(Date.now() + 600000) } }, { upsert: true });
  assert.equal((await admin.post('/api/admin/backups')).status, 409);
  await mongoose.connection.collection('appmeta').updateOne({ _id: 'backupLock' }, { $set: { until: new Date(Date.now() - 1000) } });
  assert.equal((await admin.post('/api/admin/backups')).status, 201, 'an expired lock does not block');
});

test('a failed backup is recorded and emails the administrators once a day', async () => {
  const blocker = path.join(os.tmpdir(), `gshc-not-a-dir-${process.pid}`);
  fs.writeFileSync(blocker, 'x');
  config.backupDir = blocker; backup._reset();
  try {
    const before = mail.sent.length;
    const r = await admin.post('/api/admin/backups');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /The backup failed/);
    const failed = await Backup.findOne({ ok: false }).sort({ at: -1 });
    assert.ok(failed && failed.error);
    const sent = mail.sent.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ict@example.com');
    assert.match(sent[0].subject, /daily backup failed/);
    await backup.run({ reason: 'scheduled' }); // a scheduled retry fails quietly
    assert.equal(mail.sent.length, before + 1, 'not emailed again the same day');
    const list = await admin.get('/api/admin/backups');
    assert.equal(list.body.backups[0].ok, false);
  } finally {
    config.backupDir = DIR; backup._reset();
    fs.rmSync(blocker, { force: true });
  }
});

test('a backup restores into an empty database, never over a working one', async () => {
  const r = await admin.post('/api/admin/backups');
  const entry = await Backup.findById(r.body.backup.id);
  const logs = [];
  const out = await restore({ file: path.join(DIR, entry.file), uri: DB2, log: m => logs.push(m) });
  assert.equal(out.counts.records, 1);
  assert.equal(out.copies, 1);
  const c2 = await mongoose.createConnection(DB2).asPromise();
  try {
    assert.equal(await c2.db.collection('users').countDocuments(), 3);
    const rec = await c2.db.collection('records').findOne({});
    assert.equal(String(rec._id), String((await mongoose.connection.db.collection('records').findOne({}))._id), 'ids kept');
    assert.equal(await c2.db.collection('documentcopies').countDocuments(), 1);
  } finally { await c2.close(); }
  await assert.rejects(restore({ file: path.join(DIR, entry.file), uri: DB2, log: () => {} }), /already has users/);
  const latest = await restore({ latest: true, uri: DB2 + 'x', log: () => {} }).finally(async () => {
    const c3 = await mongoose.createConnection(DB2 + 'x').asPromise(); await c3.dropDatabase(); await c3.close();
  });
  assert.equal(latest.file, entry.file, '--latest takes the newest file in the store');
});

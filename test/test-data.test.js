/*
 * Clearing the test documents before full use: needs the confirmation
 * word, backs up first, keeps users and rules, and works once only.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gshc-testdata-'));
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
process.env.BACKUP_DIR = DIR;
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_testdata';

const mongoose = require('mongoose');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const backup = require('../src/services/backup');
const { Record, DocumentCopy, Notification, AuditLog, User, FormConfig, Unit, Backup } = require('../src/models');

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
    return { status: res.status, body: await res.json() };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}) };
}
const admin = client();
let clerk;

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  const r = await admin.post('/api/admin/users', { fullName: 'Clerk One', email: 'clerk@example.com', unitKeys: ['hc1'], privileges: ['view', 'create'] });
  clerk = client();
  await clerk.post('/api/auth/login', { username: 'clerk@example.com', password: r.body.tempPassword });
  await clerk.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'Passw0rd123' });
  // Some test documents: a draft through the API, and a signed one with its copy and notification.
  await clerk.post('/api/records', { unitKey: 'hc1', formType: 'hearing-notice', data: { suitNumber: 'GM/1/2026', plaintiff: 'A', defendant: 'B', recipientName: 'C', recipientAddress: 'D', stage: 'Mention', hearingDate: '2026-11-02', hearingTime: '9', issuePlace: 'Gombe', issueDate: '2026-10-20' } });
  const signed = await Record.create({ unitKey: 'hc1', formType: 'civil-summons', status: 'final', data: {}, createdBy: r.body.user.id, finalizedAt: new Date(), verifyCode: 'GSHC-TEST-TEST-TEST' });
  await DocumentCopy.create({ record: signed._id, html: '<!DOCTYPE html>test' });
  await Notification.create({ user: r.body.user.id, kind: 'approved', record: signed._id, message: 'x' });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('administrators only, and the confirmation word is required', async () => {
  assert.equal((await clerk.get('/api/admin/test-data')).status, 403);
  assert.equal((await clerk.post('/api/admin/test-data/clear', { confirm: 'CLEAR TEST DATA' })).status, 403);
  const st = await admin.get('/api/admin/test-data');
  assert.equal(st.body.available, true);
  assert.deepEqual(st.body.counts, { records: 2, signed: 1, copies: 1, notifications: 1 });
  const wrong = await admin.post('/api/admin/test-data/clear', { confirm: 'yes' });
  assert.equal(wrong.status, 400);
  assert.equal(await Record.countDocuments(), 2, 'nothing cleared');
});

test('nothing is cleared when the backup fails', async () => {
  const blocker = path.join(os.tmpdir(), `gshc-not-a-dir-td-${process.pid}`);
  fs.writeFileSync(blocker, 'x');
  config.backupDir = blocker; backup._reset();
  try {
    const r = await admin.post('/api/admin/test-data/clear', { confirm: 'CLEAR TEST DATA' });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /Nothing was cleared, because the backup first failed/);
    assert.equal(await Record.countDocuments(), 2);
    assert.equal((await admin.get('/api/admin/test-data')).body.available, true, 'still available');
  } finally {
    config.backupDir = DIR; backup._reset();
    fs.rmSync(blocker, { force: true });
  }
});

test('clearing removes the test documents, keeps users and rules, and backs up first', async () => {
  const users = await User.countDocuments(), rules = await FormConfig.countDocuments(), units = await Unit.countDocuments();
  const r = await admin.post('/api/admin/test-data/clear', { confirm: 'clear test data' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.counts.records, 2);
  assert.ok(fs.existsSync(path.join(DIR, r.body.backupFile)), 'the backup file exists');
  assert.ok(await Backup.exists({ file: r.body.backupFile, ok: true }));

  assert.equal(await Record.countDocuments(), 0);
  assert.equal(await DocumentCopy.countDocuments(), 0);
  assert.equal(await Notification.countDocuments(), 0);
  assert.equal(await AuditLog.countDocuments({ record: { $exists: true } }), 0, 'Reports start from zero');
  assert.ok(await AuditLog.exists({ action: 'test_data_cleared' }), 'the clearing itself is logged');
  assert.ok(await AuditLog.exists({ action: 'user_created' }), 'other audit entries stay');
  assert.equal(await User.countDocuments(), users);
  assert.equal(await FormConfig.countDocuments(), rules);
  assert.equal(await Unit.countDocuments(), units);

  const v = await fetch(base + '/api/verify/GSHC-TEST-TEST-TEST').then(x => x.json());
  assert.equal(v.status, 'not_found', 'a test QR code no longer checks as genuine');
  assert.equal((await clerk.post('/api/auth/login', { username: 'clerk@example.com', password: 'Passw0rd123' })).status, 200, 'users still sign in');
});

test('it works once only', async () => {
  const st = await admin.get('/api/admin/test-data');
  assert.equal(st.body.available, false);
  assert.equal(st.body.done.counts.records, 2);
  await clerk.post('/api/records', { unitKey: 'hc1', formType: 'hearing-notice', data: { suitNumber: 'GM/2/2026', plaintiff: 'A', defendant: 'B', recipientName: 'C', recipientAddress: 'D', stage: 'Mention', hearingDate: '2026-11-02', hearingTime: '9', issuePlace: 'Gombe', issueDate: '2026-10-20' } });
  const again = await admin.post('/api/admin/test-data/clear', { confirm: 'CLEAR TEST DATA' });
  assert.equal(again.status, 409);
  assert.equal(await Record.countDocuments(), 1, 'real records are never cleared');
});

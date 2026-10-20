/*
 * Removing accounts: a deactivated account's email is named when reused,
 * the waiting count before deactivating, and deleting for good only an
 * account that is in no document.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_removal';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const { Record, User, AuditLog } = require('../src/models');

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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}
const admin = client();
const add = (fullName, email) => admin.post('/api/admin/users', { fullName, email, unitKeys: ['hc1'], privileges: ['view', 'create'], signerRoles: ['judge'] });

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
});
after(async () => { server.close(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('a test account in no document can be deleted for good, and its email used again', async () => {
  const t = await add('Test Judge', 'judge.musa@example.com');
  const id = t.body.user.id;
  assert.equal((await admin.del(`/api/admin/users/${id}/permanent`)).status, 409, 'deactivate first');
  await admin.del(`/api/admin/users/${id}`);

  // Reusing the email names the deactivated account.
  const again = await add('Aisha Musa', 'judge.musa@example.com');
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Test Judge's deactivated account/);
  assert.equal(again.body.inactiveUser.id, id);

  const d = await admin.del(`/api/admin/users/${id}/permanent`);
  assert.equal(d.status, 200);
  assert.equal(await User.exists({ _id: id }), null);
  assert.ok(await AuditLog.exists({ action: 'user_deleted', 'details.email': 'judge.musa@example.com' }), 'the deletion is in the audit log');

  const real = await add('Aisha Musa', 'judge.musa@example.com');
  assert.equal(real.status, 201, 'the email is free again');
});

test('an account named in documents can only stay deactivated', async () => {
  const s = await add('Signer One', 'signer.one@example.com');
  const id = s.body.user.id;
  const creator = (await User.findOne({ username: 'admin' }))._id;
  await Record.create({ unitKey: 'hc1', formType: 'civil-summons', status: 'pending', data: {}, createdBy: creator,
    slots: [{ role: 'judge', label: 'Judge', approvers: [id], signatures: [] }] });
  const w = await admin.get(`/api/admin/users/${id}/work`);
  assert.deepEqual(w.body, { waiting: 1, documents: 1 }, 'one form waits for their signature');
  await admin.del(`/api/admin/users/${id}`);
  const d = await admin.del(`/api/admin/users/${id}/permanent`);
  assert.equal(d.status, 409);
  assert.match(d.body.error, /named in 1 document/);
  assert.ok(await User.exists({ _id: id }));
});

test('the built in admin and your own account cannot be deleted', async () => {
  const me = await User.findOne({ username: 'admin' });
  assert.equal((await admin.del(`/api/admin/users/${me._id}/permanent`)).status, 400);
  const other = client();
  assert.equal((await other.del(`/api/admin/users/${me._id}/permanent`)).status, 401, 'administrators only');
});

test('an email held by an active account is refused plainly', async () => {
  const r = await add('Someone Else', 'signer.one@example.com');
  assert.equal(r.status, 409);
  assert.equal(r.body.inactiveUser.fullName, 'Signer One', 'signer one is deactivated');
  await User.updateOne({ email: 'signer.one@example.com' }, { $set: { active: true } });
  const r2 = await add('Someone Else', 'signer.one@example.com');
  assert.equal(r2.status, 409);
  assert.equal(r2.body.inactiveUser, undefined);
  assert.match(r2.body.error, /already taken by another account/);
});

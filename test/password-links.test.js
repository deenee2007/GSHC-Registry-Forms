/*
 * Invitations, forgot password and reset links (email captured in memory).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_links';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const mail = require('../src/services/mail');
const { PasswordToken } = require('../src/models');

let server, base;

function client() {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GSHC', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b) };
}

const tokenFrom = (msg) => decodeURIComponent(/token=([^\s"&<]+)/.exec(msg.text)[1]);
const lastMail = () => mail.sent[mail.sent.length - 1];

const admin = client();

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  const r = await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  assert.equal(r.status, 200);
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('sign in screen is told forgot password is available', async () => {
  const r = await client().get('/api/auth/options');
  assert.equal(r.body.forgotPassword, true);
  const m = await admin.get('/api/admin/meta');
  assert.equal(m.body.mailEnabled, true);
});

test('invitation: new user chooses their own password from the email link', async () => {
  let r = await admin.post('/api/admin/users', { username: 'reg2', fullName: 'Hauwa Garba', email: 'Hauwa@Example.com', sendInvite: true, unitKeys: ['hc2'], privileges: ['view'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.invited, true);
  assert.equal(r.body.tempPassword, undefined, 'no password is shown when an invitation is sent');
  const msg = lastMail();
  assert.equal(msg.to, 'hauwa@example.com');
  assert.match(msg.subject, /account/i);
  assert.match(msg.text, /reg2/);
  const token = tokenFrom(msg);

  r = await client().get('/api/auth/reset/' + token);
  assert.deepEqual([r.body.valid, r.body.kind, r.body.username], [true, 'invite', 'reg2']);

  r = await client().post('/api/auth/reset', { token, newPassword: 'short' });
  assert.equal(r.status, 400, 'password rules apply');
  r = await client().post('/api/auth/reset', { token, newPassword: 'Hauwa2026x' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await client().post('/api/auth/reset', { token, newPassword: 'Another2026' });
  assert.equal(r.status, 400, 'a link works only once');

  const u = client();
  r = await u.post('/api/auth/login', { username: 'reg2', password: 'Hauwa2026x' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.mustChangePassword, false, 'no second password change needed');
});

test('duplicate email is refused', async () => {
  const r = await admin.post('/api/admin/users', { username: 'reg3', fullName: 'Someone', email: 'hauwa@example.com' });
  assert.equal(r.status, 409);
});

test('without an email the admin still gets a one time password', async () => {
  const r = await admin.post('/api/admin/users', { username: 'clerk9', fullName: 'No Email', sendInvite: true });
  assert.equal(r.status, 201);
  assert.ok(r.body.tempPassword);
});

test('forgot password: same answer for unknown accounts, link works and signs out other browsers', async () => {
  const before = mail.sent.length;
  let r = await client().post('/api/auth/forgot', { username: 'nobody' });
  assert.equal(r.status, 200);
  const generic = r.body.message;
  assert.equal(mail.sent.length, before, 'no email for an unknown account');

  const browserA = client();
  await browserA.post('/api/auth/login', { username: 'reg2', password: 'Hauwa2026x' });
  assert.equal((await browserA.get('/api/auth/me')).status, 200);

  r = await client().post('/api/auth/forgot', { username: 'HAUWA@example.com' });
  assert.equal(r.body.message, generic, 'same message whether or not the account exists');
  const token = tokenFrom(lastMail());
  assert.match(lastMail().subject, /reset/i);

  r = await client().post('/api/auth/reset', { token, newPassword: 'Fresh2026yy' });
  assert.equal(r.status, 200);
  assert.equal((await browserA.get('/api/auth/me')).status, 401, 'other sessions end after a reset');
  r = await client().post('/api/auth/login', { username: 'reg2', password: 'Fresh2026yy' });
  assert.equal(r.status, 200);
});

test('a new link cancels the previous one; expired links fail', async () => {
  await client().post('/api/auth/forgot', { username: 'reg2' });
  const first = tokenFrom(lastMail());
  const users = await admin.get('/api/admin/users');
  const reg2 = users.body.users.find(u => u.username === 'reg2');
  let r = await admin.post(`/api/admin/users/${reg2.id}/send-link`);
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'reset', 'a user who has signed in gets a reset link');
  const second = tokenFrom(lastMail());
  assert.equal((await client().get('/api/auth/reset/' + first)).body.valid, false);
  assert.equal((await client().get('/api/auth/reset/' + second)).body.valid, true);

  await PasswordToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await client().get('/api/auth/reset/' + second)).body.valid, false);
  r = await client().post('/api/auth/reset', { token: second, newPassword: 'Late2026zz' });
  assert.equal(r.status, 400);
});

test('changing your own password signs out your other browsers but not this one', async () => {
  const a = client(), b = client();
  await a.post('/api/auth/login', { username: 'reg2', password: 'Fresh2026yy' });
  await b.post('/api/auth/login', { username: 'reg2', password: 'Fresh2026yy' });
  const r = await a.post('/api/auth/change-password', { currentPassword: 'Fresh2026yy', newPassword: 'Mine2026abc' });
  assert.equal(r.status, 200);
  assert.equal((await a.get('/api/auth/me')).status, 200, 'this browser stays signed in');
  assert.equal((await b.get('/api/auth/me')).status, 401, 'the other browser is signed out');
});

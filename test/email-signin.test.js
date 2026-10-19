/*
 * Signing in with an email address: new accounts use the email as their
 * username, existing accounts are switched once, and staff without email
 * keep a username.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_emailsignin';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { seedAll, usernamesToEmail } = require('../src/services/seed');
const mail = require('../src/services/mail');
const { User } = require('../src/models');

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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b) };
}
const admin = client();
const signIn = (username, password) => client().post('/api/auth/login', { username, password });

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

test('a new user with an email signs in with it; no username needed', async () => {
  const r = await admin.post('/api/admin/users', { fullName: 'Aisha Musa', email: 'Aisha.Musa@Example.com', unitKeys: ['hc1'], privileges: ['view'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.username, 'aisha.musa@example.com');
  assert.equal((await signIn('aisha.musa@example.com', r.body.tempPassword)).status, 200);
  assert.equal((await signIn('AISHA.MUSA@EXAMPLE.COM', r.body.tempPassword)).status, 200, 'capitals do not matter');
});

test('staff without email still get a username; one of the two is required', async () => {
  const r = await admin.post('/api/admin/users', { fullName: 'Bala Idris', username: 'bala', unitKeys: ['hc1'], privileges: ['view'] });
  assert.equal(r.status, 201);
  assert.equal((await signIn('bala', r.body.tempPassword)).status, 200);
  assert.equal((await admin.post('/api/admin/users', { fullName: 'No Name' })).status, 400);
  assert.equal((await admin.post('/api/admin/users', { fullName: 'Dup', email: 'aisha.musa@example.com' })).status, 409, 'an email belongs to one account');
  assert.equal((await admin.post('/api/admin/users', { fullName: 'Dup', username: 'aisha.musa@example.com', email: 'other@example.com' })).status, 409);
});

test('adding or changing the email moves the username to it; the built in admin keeps "admin"', async () => {
  const bala = await User.findOne({ username: 'bala' });
  let r = await admin.patch(`/api/admin/users/${bala._id}`, { email: 'bala.idris@example.com' });
  assert.equal(r.body.user.username, 'bala.idris@example.com', 'email added: sign in with it');
  r = await admin.patch(`/api/admin/users/${bala._id}`, { email: 'b.idris@example.com' });
  assert.equal(r.body.user.username, 'b.idris@example.com', 'email changed: username follows');
  const adm = await User.findOne({ username: 'admin' });
  r = await admin.patch(`/api/admin/users/${adm._id}`, { email: 'ict@example.com' });
  assert.equal(r.body.user.username, 'admin');
  assert.equal((await signIn('ict@example.com', 'NewAdmin123')).status, 200, 'the admin can sign in by email too');
  assert.equal((await signIn('admin', 'NewAdmin123')).status, 200);
});

test('existing accounts switch to their email once at start up', async () => {
  await mongoose.connection.collection('appmeta').deleteOne({ _id: 'usernamesToEmail' });
  const hash = await bcrypt.hash('Passw0rd123', 4);
  await User.create({ username: 'judge1', fullName: 'Judge One', email: 'judge1@example.com', passwordHash: hash });
  await User.create({ username: 'clerk9', fullName: 'Clerk Nine', passwordHash: hash }); // no email
  const logs = [];
  await usernamesToEmail(m => logs.push(m));
  assert.equal((await User.findOne({ fullName: 'Judge One' })).username, 'judge1@example.com');
  assert.equal((await User.findOne({ fullName: 'Clerk Nine' })).username, 'clerk9');
  assert.equal((await User.findOne({ role: 'admin' })).username, 'admin');
  assert.ok(logs.some(l => /account\(s\) now use their email/.test(l)));
  assert.equal((await signIn('judge1@example.com', 'Passw0rd123')).status, 200);

  // Once only: a username chosen later is not overwritten at the next start.
  await User.updateOne({ fullName: 'Judge One' }, { $set: { username: 'chosen' } });
  await usernamesToEmail(() => {});
  assert.equal((await User.findOne({ fullName: 'Judge One' })).username, 'chosen');
});

test('the invitation email tells them to sign in with their email', () => {
  const m = mail.inviteMessage({ fullName: 'A', username: 'a@example.com', email: 'a@example.com' }, 'http://x/link', 24);
  assert.match(m.text, /You sign in with your email address, a@example\.com/);
  assert.match(mail.inviteMessage({ fullName: 'B', username: 'bala' }, 'http://x', 24).text, /Your username is "bala"/);
});

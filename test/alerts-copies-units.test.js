/*
 * Email alerts (and their switches), saved copies of signed documents,
 * and adding units.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_alerts';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const mail = require('../src/services/mail');
const { DocumentCopy } = require('../src/models');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
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
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b) };
}

const admin = client();
const u = {};

async function makeUser(spec) {
  const r = await admin.post('/api/admin/users', spec);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = client();
  await c.post('/api/auth/login', { username: spec.username, password: r.body.tempPassword });
  await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'Passw0rd123' });
  c.id = r.body.user.id;
  return c;
}

const summons = {
  suitNumber: 'GM/77/2026', plaintiff: 'A', plaintiffAddress: 'B', defendant: 'C', recipientName: 'C',
  recipientAddress: 'D', appearanceDate: '2026-11-02', appearanceTime: '9:00', timePeriod: 'forenoon', issueDate: '2026-10-16'
};
const mailsTo = (addr) => mail.sent.filter(m => m.to === addr);

async function submitSummons() {
  const r = await u.clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons });
  await u.clerk.post(`/api/records/${r.body.record.id}/submit`, { approvers: [[u.judge.id]] });
  return r.body.record.id;
}

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  u.judge = await makeUser({ username: 'judge1', fullName: 'Judge One', title: 'Hon. Justice', email: 'judge@example.com', unitKeys: ['hc1'], signerRoles: ['judge'] });
  u.clerk = await makeUser({ username: 'clerk1', fullName: 'Clerk One', email: 'clerk@example.com', unitKeys: ['hc1'], privileges: ['view', 'create', 'edit', 'finalize', 'print'] });
  await u.judge.post('/api/me/signature', { password: 'Passw0rd123', dataUrl: PNG });
  await u.judge.post('/api/me/signing-pin', { password: 'Passw0rd123', pin: '2468' });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('signer is emailed when a form waits; submitter when it is approved', async () => {
  const id = await submitSummons();
  const j = mailsTo('judge@example.com');
  assert.equal(j.length, 1);
  assert.match(j[0].subject, /For your signature · GM\/77\/2026/);
  assert.match(j[0].text, /waiting for your signature/);
  await u.judge.post(`/api/records/${id}/approve`, { pin: '2468' });
  const c = mailsTo('clerk@example.com');
  assert.equal(c.length, 1);
  assert.match(c[0].subject, /Approved and ready to print/);
});

test('a user can switch their own alerts off', async () => {
  const r = await u.judge.patch('/api/me/preferences', { emailAlerts: false });
  assert.equal(r.body.user.emailAlerts, false);
  const before = mailsTo('judge@example.com').length;
  await submitSummons();
  assert.equal(mailsTo('judge@example.com').length, before, 'no email after switching off');
  const notes = await u.judge.get('/api/notifications?unread=1');
  assert.ok(notes.body.unread >= 2, 'in app notifications still arrive');
  await u.judge.patch('/api/me/preferences', { emailAlerts: true });
});

test('the admin can switch alerts off for one user', async () => {
  await admin.patch(`/api/admin/users/${u.judge.id}`, { emailAlertsBlocked: true });
  const before = mailsTo('judge@example.com').length;
  await submitSummons();
  assert.equal(mailsTo('judge@example.com').length, before);
  const me = await u.judge.get('/api/auth/me');
  assert.equal(me.body.user.emailAlertsBlocked, true, 'the user can see it was switched off for them');
  await admin.patch(`/api/admin/users/${u.judge.id}`, { emailAlertsBlocked: false });
});

test('the admin can switch alerts off for everybody', async () => {
  let r = await admin.put('/api/admin/settings', { emailAlerts: false });
  assert.equal(r.body.settings.emailAlerts, false);
  const before = mail.sent.length;
  await submitSummons();
  assert.equal(mail.sent.length, before);
  r = await admin.get('/api/admin/meta');
  assert.equal(r.body.settings.emailAlerts, false);
  await admin.put('/api/admin/settings', { emailAlerts: true });
  await submitSummons();
  assert.equal(mail.sent.length, before + 1, 'back on');
});

test('a signed document has a saved, self contained copy to download', async () => {
  const id = await submitSummons();
  await u.judge.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.ok(await DocumentCopy.exists({ record: id }), 'saved at the moment of signing');
  const rec = (await u.clerk.get(`/api/records/${id}`)).body.record;
  const r = await u.clerk.get(`/api/records/${id}/copy`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="Civil_Summons_GM-77-2026_GSHC-/);
  const html = r.body;
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes(rec.verifyCode));
  assert.ok(html.includes('Hon. Justice Judge One'));
  assert.ok(!/src="\/(api|assets)\//.test(html), 'no links back to the server: images are inside the file');
  assert.ok(html.includes('data:image/png;base64'), 'signature, emblems and QR embedded');
  assert.ok(!html.includes('NOT VALID'), 'no draft watermark on the signed copy');

  const draft = await u.clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons });
  assert.equal((await u.clerk.get(`/api/records/${draft.body.record.id}/copy`)).status, 409, 'drafts have no saved copy');

  await u.judge.post(`/api/records/${id}/revoke`, { reason: 'Issued in error' });
  const revoked = await u.clerk.get(`/api/records/${id}/copy`);
  assert.ok(revoked.body.includes('REVOKED') && revoked.body.includes('Issued in error'));
});

test('add a Court Registry or an Other Unit, but not Appeals or Execution', async () => {
  let r = await admin.post('/api/admin/units', { type: 'registry', name: 'High Court 10 Registry' });
  assert.equal(r.status, 201);
  assert.equal(r.body.unit.key, 'hc10');
  r = await admin.post('/api/admin/units', { type: 'appeals', name: 'Second Appeals' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/admin/units', { type: 'general', name: 'Probate Registry' });
  assert.equal(r.status, 201);
  assert.equal(r.body.unit.key, 'probate_registry');
  r = await admin.post('/api/admin/units', { type: 'general', name: 'Probate Registry' });
  assert.equal(r.body.unit.key, 'probate_registry_2', 'same name gets its own key');

  let units = (await admin.get('/api/catalogue/units')).body.units;
  assert.deepEqual(units.find(x => x.key === 'probate_registry').forms, [], 'no forms until chosen');
  await admin.patch('/api/admin/units/probate_registry', { allowedForms: ['hearing-notice', 'affidavit-of-means'] });
  units = (await admin.get('/api/catalogue/units')).body.units;
  assert.deepEqual(units.find(x => x.key === 'probate_registry').forms, ['hearing-notice', 'affidavit-of-means']);
  assert.equal(units[units.length - 1].type, 'general', 'other units are listed last');
});

/*
 * End to end tests of the API against a real MongoDB.
 * Run with: npm test   (uses TEST_MONGODB_URI, default a local mongod)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
const DB = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const { Record } = require('../src/models');

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let server, base;

// A tiny client that keeps its own session cookie, like one browser.
function client() {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GSHC', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer(), type };
  }
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p), raw: call,
    async login(username, password) { const r = await call('POST', '/api/auth/login', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r; }
  };
}

const admin = client();
const users = {};

async function makeUser(spec) {
  const r = await admin.post('/api/admin/users', spec);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = client();
  await c.login(spec.username, r.body.tempPassword);
  const ch = await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'Passw0rd123' });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  c.id = r.body.user.id;
  return c;
}

async function makeSigner(c) {
  let r = await c.post('/api/me/signature', { password: 'Passw0rd123', dataUrl: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await c.post('/api/me/signing-pin', { password: 'Passw0rd123', pin: '2468' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

const summons = {
  suitNumber: 'GM/12/2026', plaintiff: 'Musa Bello', plaintiffAddress: 'Gombe', defendant: 'Ali Sani',
  recipientName: 'Ali Sani', recipientAddress: 'Tudun Wada, Gombe', appearanceDate: '2026-11-02',
  appearanceTime: '9:00', timePeriod: 'morning', issueDate: '2026-10-16'
};

async function fillRequired(formType, extra) {
  const { get } = require('../src/forms/catalogue');
  const data = {};
  get(formType).schema.filter(s => s.name && s.required).forEach(s => {
    data[s.name] = s.type === 'table' ? [{ suitNumber: 'GM/1/2026', parties: 'A v. B' }] : (s.options ? (s.options[0].value || s.options[0]) : 'x');
  });
  return { ...data, ...extra };
}

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('sign in: generic errors, forced password change, header check', async () => {
  const anon = client();
  let r = await anon.post('/api/auth/login', { username: 'nobody', password: 'x' });
  assert.equal(r.status, 401);
  const r2 = await anon.post('/api/auth/login', { username: 'admin', password: 'wrong' });
  assert.equal(r2.body.error, r.body.error, 'same message for unknown user and wrong password');

  r = await admin.login('admin', 'Admin12345');
  assert.equal(r.body.user.mustChangePassword, true);
  r = await admin.get('/api/admin/users');
  assert.equal(r.status, 403, 'blocked until password changed');
  r = await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'short' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  assert.equal(r.status, 200);

  r = await admin.raw('POST', '/api/admin/units', { name: 'X' }, { 'X-Requested-With': '' });
  assert.equal(r.status, 403, 'state changing call without app header is rejected');
});

test('set up users', async () => {
  users.judge1 = await makeUser({ username: 'judge1', fullName: 'A. B. Musa', title: 'Hon. Justice', unitKeys: ['hc1'], signerRoles: ['judge'] });
  users.judge2 = await makeUser({ username: 'judge2', fullName: 'C. D. Yusuf', title: 'Hon. Justice', unitKeys: ['hc2'], signerRoles: ['judge'] });
  users.registrar = await makeUser({ username: 'reg1', fullName: 'Registrar One', unitKeys: ['hc1'], signerRoles: ['registrar'], privileges: ['view', 'create', 'edit', 'finalize', 'print'] });
  users.clerk = await makeUser({ username: 'clerk1', fullName: 'Clerk One', unitKeys: ['hc1'], privileges: ['view', 'create', 'edit', 'finalize', 'delete', 'print'] });
  users.outsider = await makeUser({ username: 'clerk2', fullName: 'Clerk Two', unitKeys: ['hc3'], privileges: ['view', 'create'] });
  for (const k of ['judge1', 'judge2', 'registrar']) await makeSigner(users[k]);

  const r = await users.clerk.get('/api/catalogue/signers?role=judge&unitKey=hc1');
  assert.deepEqual(r.body.signers.map(s => s.fullName), ['A. B. Musa']);
});

test('judge form: submit, approve with PIN, returns to submitter as approved', async () => {
  const { clerk, judge1, outsider } = users;
  let r = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: { suitNumber: 'GM/1/2026' } });
  assert.equal(r.status, 400, 'required fields enforced on the server');

  r = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.record.id;
  assert.equal(r.body.record.ref, 'GM/12/2026');

  r = await outsider.get(`/api/records/${id}`);
  assert.equal(r.status, 403, 'other units cannot see the record');

  r = await clerk.post(`/api/records/${id}/submit`, {});
  assert.equal(r.status, 400, 'must choose the judge');
  r = await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge1.id]] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.record.status, 'pending');

  r = await clerk.put(`/api/records/${id}`, { data: summons });
  assert.equal(r.status, 409, 'locked while waiting for the judge');

  r = await judge1.get('/api/records/inbox');
  assert.equal(r.body.records.length, 1);
  r = await judge1.get('/api/notifications?unread=1');
  assert.equal(r.body.unread, 1);

  r = await judge1.post(`/api/records/${id}/approve`, { pin: '0000' });
  assert.equal(r.status, 400, 'wrong PIN rejected');
  r = await judge1.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.record.status, 'final');
  assert.match(r.body.record.verifyCode, /^GSHC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(r.body.record.verifyUrl.endsWith('/verify/' + r.body.record.verifyCode));

  r = await clerk.get('/api/records/submitted?status=final');
  assert.deepEqual(r.body.records.map(x => x.id), [id], 'appears under Approved for the submitter');
  r = await clerk.get('/api/notifications');
  assert.equal(r.body.notifications[0].kind, 'approved');

  r = await clerk.get(`/api/records/${id}/document`);
  assert.equal(r.status, 200);
  assert.ok(r.body.document.qrDataUrl.startsWith('data:image/png'));
  assert.equal(r.body.document.signatures[0].name, 'A. B. Musa');
  const img = await clerk.get(r.body.document.signatures[0].imageUrl);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/png');

  r = await clerk.put(`/api/records/${id}`, { data: summons });
  assert.equal(r.status, 409, 'final records cannot be edited');
  r = await clerk.del(`/api/records/${id}`);
  assert.equal(r.status, 409, 'final records cannot be deleted');
  r = await clerk.post(`/api/records/${id}/printed`);
  assert.equal(r.body.record.printCount, 1);

  // Public verification, then tampering is detected.
  const code = (await clerk.get(`/api/records/${id}`)).body.record.verifyCode;
  r = await client().get('/api/verify/' + code.toLowerCase().replace(/-/g, ' '));
  assert.equal(r.body.status, 'valid');
  assert.equal(r.body.reference, 'GM/12/2026');
  assert.equal(r.body.data, undefined, 'contents are not exposed');
  await Record.updateOne({ _id: id }, { $set: { 'data.defendant': 'Someone Else' } });
  r = await client().get('/api/verify/' + code);
  assert.equal(r.body.status, 'tampered');
  await Record.updateOne({ _id: id }, { $set: { 'data.defendant': summons.defendant } });

  r = await judge1.post(`/api/records/${id}/revoke`, { reason: 'Issued in error' });
  assert.equal(r.status, 200);
  r = await client().get('/api/verify/' + code);
  assert.equal(r.body.status, 'revoked');
  r = await client().get('/api/verify/GSHC-AAAA-BBBB-CCCC');
  assert.equal(r.body.status, 'not_found');
});

test('registrar form: signed and final on finalise', async () => {
  const { registrar } = users;
  const data = await fillRequired('hearing-notice');
  let r = await registrar.post('/api/records', { unitKey: 'hc1', formType: 'hearing-notice', data });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.record.id;
  r = await registrar.post(`/api/records/${id}/submit`, {});
  assert.equal(r.status, 400, 'PIN required to sign');
  r = await registrar.post(`/api/records/${id}/submit`, { pin: '2468' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.record.status, 'final');
  assert.equal(r.body.record.slots[0].signatures[0].name, 'Registrar One');
});

test('external form: finalises without a digital signature', async () => {
  const { clerk } = users;
  let r = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'bail-bond', data: await fillRequired('bail-bond') });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await clerk.post(`/api/records/${r.body.record.id}/submit`, {});
  assert.equal(r.body.record.status, 'final');
  assert.equal(r.body.record.slots.length, 0);
});

test('return with comments, correct and resubmit', async () => {
  const { clerk, judge1 } = users;
  let r = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons });
  const id = r.body.record.id;
  await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge1.id]] });
  r = await judge1.post(`/api/records/${id}/return`, {});
  assert.equal(r.status, 400, 'comment required');
  r = await judge1.post(`/api/records/${id}/return`, { comment: 'Correct the defendant address' });
  assert.equal(r.body.record.status, 'returned');
  r = await clerk.get('/api/records/submitted?status=returned');
  assert.equal(r.body.records[0].returnComment, 'Correct the defendant address');
  r = await clerk.put(`/api/records/${id}`, { data: { ...summons, recipientAddress: 'New address' } });
  assert.equal(r.status, 200);
  r = await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge1.id]] });
  assert.equal(r.body.record.status, 'pending');
  r = await judge1.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(r.body.record.status, 'final');
});

test('panel order: "all" needs every judge, "any" needs one', async () => {
  const { clerk, judge1, judge2 } = users;
  const data = await fillRequired('court-order', { judgeType: 'panel' });

  let r = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'court-order', data });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let id = r.body.record.id;
  r = await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge1.id, judge2.id]], rules: ['all'] });
  assert.equal(r.body.record.status, 'pending');
  r = await judge1.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(r.body.record.status, 'pending', 'still waiting for the second judge');
  r = await judge1.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(r.status, 403, 'cannot sign twice');
  r = await judge2.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(r.body.record.status, 'final');
  assert.equal(r.body.record.slots[0].signatures.length, 2);

  r = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'court-order', data });
  id = r.body.record.id;
  await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge1.id, judge2.id]], rules: ['any'] });
  r = await judge2.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(r.body.record.status, 'final');
  r = await judge1.get('/api/records/inbox');
  assert.ok(!r.body.records.some(x => x.id === id), 'leaves the other judge\'s inbox');
});

test('signing PIN locks after repeated failures', async () => {
  const { clerk, judge2 } = users;
  const r0 = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons });
  const id = r0.body.record.id;
  await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge2.id]] });
  for (let i = 0; i < 5; i++) await judge2.post(`/api/records/${id}/approve`, { pin: '1111' });
  const r = await judge2.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(r.status, 429);
});

test('admin can change who signs a form', async () => {
  let r = await admin.put('/api/admin/forms/bail-bond/signers', { signers: [{ role: 'registrar', label: 'Registrar' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await users.registrar.post('/api/records', { unitKey: 'hc1', formType: 'bail-bond', data: await fillRequired('bail-bond') });
  r = await users.registrar.post(`/api/records/${r.body.record.id}/submit`, { pin: '2468' });
  assert.equal(r.body.record.status, 'final');
  assert.equal(r.body.record.slots[0].label, 'Registrar');
  r = await admin.get('/api/admin/audit?action=record_finalized');
  assert.ok(r.body.entries.length >= 1, 'actions are audited');
});

test('a signer sees the forms they signed and returned', async () => {
  const { clerk, judge1 } = users;
  const r = await clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: { ...summons, suitNumber: 'GM/909/2026' } });
  const id = r.body.record.id;
  await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge1.id]] });
  await judge1.post(`/api/records/${id}/return`, { comment: 'Fix the address' });
  let mine = await judge1.get('/api/records/by-me?kind=returned');
  assert.ok(mine.body.records.some(x => x.id === id && x.myComment === 'Fix the address'), 'returned by me, with my comment');
  await clerk.post(`/api/records/${id}/submit`, { approvers: [[judge1.id]] });
  const ok = await judge1.post(`/api/records/${id}/approve`, { pin: '2468' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  mine = await judge1.get('/api/records/by-me?kind=signed');
  assert.equal(mine.body.records[0].id, id, 'newest first');
  assert.ok(mine.body.records[0].myAt);
  assert.equal((await judge1.get('/api/records/by-me?kind=signed&q=GM/909')).body.records.length, 1, 'searched by suit number');
  assert.equal((await clerk.get('/api/records/by-me?kind=signed')).body.records.length, 0, 'only what this person signed');
  assert.ok((await judge1.get('/api/records/stats')).body.signedThisMonth >= 1);
});

test('a judge sees all of the court\'s forms once the administrator ticks View in Settings, Users', async () => {
  const { judge1 } = users;
  assert.equal((await judge1.get('/api/records?unitKey=hc1')).status, 403, 'without View: only the forms sent to them');
  const u = await admin.raw('PATCH', `/api/admin/users/${judge1.id}`, { privileges: ['view'] });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const list = await judge1.get('/api/records?unitKey=hc1');
  assert.equal(list.status, 200);
  assert.ok(list.body.records.length >= 1, 'every form of High Court 1');
  assert.equal((await judge1.get('/api/records?unitKey=hc3')).status, 403, 'not other courts');
  assert.equal((await judge1.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons })).status, 403, 'View alone does not let them make forms');
  await admin.raw('PATCH', `/api/admin/users/${judge1.id}`, { privileges: [] });
});

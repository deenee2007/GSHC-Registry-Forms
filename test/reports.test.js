/*
 * Reports: who may see what, the counts, and the filters.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_reports';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const { Record } = require('../src/models');

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
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b) };
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

const summons = (n) => ({
  suitNumber: `GM/${n}/2026`, plaintiff: 'A', plaintiffAddress: 'B', defendant: 'C', recipientName: 'C',
  recipientAddress: 'D', appearanceDate: '2026-11-02', appearanceTime: '9:00', timePeriod: 'forenoon', issueDate: '2026-10-16'
});
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD
const q = (o) => '/api/reports?' + new URLSearchParams({ from: today, to: today, ...o });

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  u.judge = await makeUser({ username: 'judge1', fullName: 'Judge One', title: 'Hon. Justice', unitKeys: ['hc1'], signerRoles: ['judge'] });
  u.clerk1 = await makeUser({ username: 'clerk1', fullName: 'Clerk One', unitKeys: ['hc1'], privileges: ['view', 'create', 'finalize', 'reports'] });
  u.clerk2 = await makeUser({ username: 'clerk2', fullName: 'Clerk Two', unitKeys: ['hc2'], privileges: ['view', 'create', 'finalize'] });
  await u.judge.post('/api/me/signature', { password: 'Passw0rd123', dataUrl: PNG });
  await u.judge.post('/api/me/signing-pin', { password: 'Passw0rd123', pin: '2468' });

  // HC1: three summonses: one approved, one returned, one still waiting. One bail bond finalised directly.
  for (let i = 1; i <= 3; i++) {
    const r = await u.clerk1.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons(i) });
    await u.clerk1.post(`/api/records/${r.body.record.id}/submit`, { approvers: [[u.judge.id]] });
    if (i === 1) await u.judge.post(`/api/records/${r.body.record.id}/approve`, { pin: '2468' });
    if (i === 2) await u.judge.post(`/api/records/${r.body.record.id}/return`, { comment: 'Fix address' });
  }
  const { get } = require('../src/forms/catalogue');
  const bail = {};
  get('bail-bond').schema.filter(s => s.name && s.required).forEach(s => { bail[s.name] = s.options ? (s.options[0].value || s.options[0]) : 'x'; });
  const b = await u.clerk1.post('/api/records', { unitKey: 'hc1', formType: 'bail-bond', data: bail });
  await u.clerk1.post(`/api/records/${b.body.record.id}/submit`, {});
  // HC2: one draft.
  await u.clerk2.post('/api/records', { unitKey: 'hc2', formType: 'civil-summons', data: summons(9) });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('who may see reports', async () => {
  assert.equal((await u.clerk2.get(q())).status, 403, 'needs the reports privilege');
  assert.equal((await u.judge.get(q())).status, 403);
  assert.equal((await u.clerk1.get(q())).status, 200);
  assert.equal((await admin.get(q())).status, 200);
  assert.equal((await admin.get('/api/reports?from=2026-13-01&to=x')).status, 400);
});

test('admin sees every court and can filter by court', async () => {
  let r = await admin.get(q());
  assert.equal(r.body.totals.created, 5);
  assert.equal(r.body.totals.submitted, 4);
  assert.equal(r.body.totals.signed, 2, 'the approved summons and the bail bond');
  assert.equal(r.body.totals.returned, 1);
  assert.equal(r.body.totals.pendingNow, 1);
  assert.equal(r.body.totals.approvals, 1);
  assert.ok(r.body.totals.avgApprovalHours >= 0);
  assert.deepEqual(r.body.byUnit.map(x => [x.name, x.created]), [['High Court 1 Registry', 4], ['High Court 2 Registry', 1]]);
  r = await admin.get(q({ unitKey: 'hc2' }));
  assert.equal(r.body.totals.created, 1);
  assert.equal(r.body.totals.signed, 0);
});

test('a unit user sees only their own unit; a court filter is ignored', async () => {
  const r = await u.clerk1.get(q({ unitKey: 'hc2' }));
  assert.equal(r.body.totals.created, 4, 'still High Court 1 only');
  assert.equal(r.body.byUnit, undefined, 'no by court table for unit users');
  assert.deepEqual(r.body.scope.units.map(x => x.key), ['hc1']);
  const o = await u.clerk1.get('/api/reports/options');
  assert.deepEqual(o.body.units.map(x => x.key), ['hc1']);
  assert.equal(o.body.isAdmin, false);
});

test('form, status and signer filters; by form and by signer tables; documents list', async () => {
  let r = await admin.get(q({ formType: 'bail-bond' }));
  assert.equal(r.body.totals.created, 1);
  assert.equal(r.body.totals.signed, 1);
  r = await admin.get(q({ status: 'pending' }));
  assert.equal(r.body.totals.created, 1);
  assert.equal(r.body.totals.pendingNow, 1);
  r = await admin.get(q({ signer: u.judge.id }));
  assert.equal(r.body.totals.created, 3, 'only records sent to that judge');
  assert.deepEqual(r.body.bySigner.map(s => [s.name, s.signatures]), [['Hon. Justice Judge One', 1]]);

  r = await admin.get(q());
  const forms = Object.fromEntries(r.body.byForm.map(f => [f.label, f]));
  assert.equal(forms['Civil Summons'].created, 4);
  assert.equal(forms['Civil Summons'].returned, 1);
  assert.equal(r.body.basis, 'signed');
  assert.equal(r.body.records.length, 2, 'documents signed in the period');
  assert.ok(r.body.records.some(x => x.signedBy === 'Hon. Justice Judge One'));
  r = await admin.get(q({ basis: 'created' }));
  assert.equal(r.body.records.length, 5);
});

test('a period with no activity reports zeros', async () => {
  const r = await admin.get('/api/reports?from=2020-01-01&to=2020-01-31');
  assert.equal(r.body.totals.created, 0);
  assert.equal(r.body.records.length, 0);
  assert.equal(r.body.totals.pendingNow, 1, 'waiting now is shown whatever the period');
});

test('older activity falls outside today', async () => {
  const old = new Date(Date.now() - 40 * 86400000);
  await Record.collection.updateMany({ unitKey: 'hc2' }, { $set: { createdAt: old } }); // Mongoose protects createdAt
  const r = await admin.get(q({ unitKey: 'hc2' }));
  assert.equal(r.body.totals.created, 0);
});

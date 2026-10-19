/*
 * The case file: case numbers on records, the search across units, what
 * users outside a unit may see, and filling in numbers on older records.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_cases';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll, fillCaseNumbers } = require('../src/services/seed');
const catalogue = require('../src/forms/catalogue');
const { Record, User } = require('../src/models');

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
const u = {};
async function makeUser(spec) {
  const r = await admin.post('/api/admin/users', spec);
  const c = client();
  await c.post('/api/auth/login', { username: spec.username, password: r.body.tempPassword });
  await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'Passw0rd123' });
  c.id = r.body.user.id;
  return c;
}
const summons = (suitNumber) => ({ suitNumber, plaintiff: 'Musa Bello', plaintiffAddress: 'B', defendant: 'Ali Sani', recipientName: 'C',
  recipientAddress: 'D', appearanceDate: '2026-11-02', appearanceTime: '9:00', timePeriod: 'forenoon', issueDate: '2026-10-16' });

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  const privileges = ['view', 'create', 'edit', 'finalize', 'print'];
  u.clerk = await makeUser({ username: 'clerk1', fullName: 'Clerk One', unitKeys: ['hc1'], privileges });
  u.clerk2 = await makeUser({ username: 'clerk2', fullName: 'Clerk Two', unitKeys: ['hc2'], privileges });
  u.bailiff = await makeUser({ username: 'bailiff', fullName: 'Bailiff One', unitKeys: ['execution'], privileges });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('case numbers are read from every kind of number field and written one way', () => {
  assert.deepEqual(catalogue.caseNumbers('civil-summons', { suitNumber: ' gm / 45 / 2026. ' }), ['GM/45/2026']);
  assert.deepEqual(catalogue.caseNumbers('cause-list', { entries: [{ suitNumber: 'GM/1/2026' }, { suitNumber: 'gm/1/2026' }, { suitNumber: 'GM/2/2026' }] }), ['GM/1/2026', 'GM/2/2026']);
  assert.deepEqual(catalogue.caseNumbers('court-order', { suitNumber: 'GMA/3/2026', additionalSuits: 'GMA/4/2026\nGMA/5/2026\n' }), ['GMA/3/2026', 'GMA/4/2026', 'GMA/5/2026']);
  assert.deepEqual(catalogue.caseNumbers('notice-appeal-fixed', { highCourtAppealNo: 'GMA/3/2026', lowerCourtSuitNo: 'UACK/40/2026' }), ['GMA/3/2026', 'UACK/40/2026']);
  assert.deepEqual(catalogue.caseNumbers('writ-possession-property', { suitNumber: 'GM/45/2026' }), ['GM/45/2026']);
  assert.deepEqual(catalogue.caseNumbers('civil-summons', { suitNumber: '' }), []);
  // Every form has somewhere to put a case number.
  for (const [key, def] of Object.entries(catalogue.forms)) {
    const data = Object.fromEntries(def.schema.filter(f => f.name).map(f => [f.name, f.type === 'table' ? [{ suitNumber: 'GM/9/2026' }] : 'GM/9/2026']));
    assert.ok(catalogue.caseNumbers(key, data).includes('GM/9/2026'), `${key} has no case number field`);
  }
});

test('the case file lists every document for a number across units, oldest first', async () => {
  const a = await u.clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons('GM/45/2026') });
  assert.deepEqual(a.body.record.caseNos, ['GM/45/2026']);
  await u.clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons('gm/45/2026') });
  await u.clerk.post('/api/records', { unitKey: 'hc1', formType: 'civil-summons', data: summons('GM/145/2026') });
  // An execution document for the same case, already submitted.
  await Record.create({ unitKey: 'execution', formType: 'notice-of-attachment', status: 'final', data: { suitNumber: 'GM/45/2026' },
    caseNos: ['GM/45/2026'], summary: 'Musa Bello', createdBy: u.bailiff.id, createdByName: 'Bailiff One', finalizedAt: new Date() });
  // An execution draft: private to that unit.
  await Record.create({ unitKey: 'execution', formType: 'notice-to-vacate', status: 'draft', data: { suitNumber: 'GM/45/2026' },
    caseNos: ['GM/45/2026'], createdBy: u.bailiff.id, createdByName: 'Bailiff One' });

  const r = await u.clerk.get('/api/cases?q=GM/45/2026');
  assert.equal(r.status, 200);
  const exact = r.body.cases[0];
  assert.equal(exact.caseNo, 'GM/45/2026', 'the number typed in full comes first');
  assert.equal(exact.parties, 'Musa Bello');
  assert.equal(exact.documents.length, 3, 'two summonses and the signed notice; not the other unit\'s draft');
  const ex = exact.documents.find(d => d.unitKey === 'execution');
  assert.equal(ex.canOpen, false);
  assert.equal(ex.id, null, 'no way to open it');
  assert.equal(ex.summary, '');
  assert.equal(ex.createdByName, '');
  assert.match(ex.formLabel, /^Notice of Attachment/);
  assert.equal(ex.status, 'final');
  assert.ok(exact.documents.filter(d => d.unitKey === 'hc1').every(d => d.canOpen && d.id));
  assert.deepEqual(exact.units.sort(), ['Execution / Bailiffs Unit', 'High Court 1 Registry']);
  assert.ok(!r.body.cases.some(c => c.caseNo === 'GM/145/2026'));
  const part = await u.clerk.get('/api/cases?q=45/2026');
  assert.deepEqual(part.body.cases.map(c => c.caseNo).sort(), ['GM/145/2026', 'GM/45/2026'], 'part of a number finds every case containing it');

  const only = await u.clerk.get('/api/cases?q=GM/45/2026&exact=1');
  assert.deepEqual(only.body.cases.map(c => c.caseNo), ['GM/45/2026']);

  // The bailiff sees their own draft and can open it; the court summonses are listed without contents.
  const b = await u.bailiff.get('/api/cases?q=gm / 45 / 2026&exact=1');
  const docs = b.body.cases[0].documents;
  assert.equal(docs.length, 2, 'court drafts are private to the court');
  assert.ok(docs.every(d => d.unitKey === 'execution' && d.canOpen));

  const all = await admin.get('/api/cases?q=GM/45/2026&exact=1');
  assert.equal(all.body.cases[0].documents.length, 4, 'an administrator sees everything');
});

test('the search needs at least 3 characters and a signed in user', async () => {
  assert.equal((await u.clerk.get('/api/cases?q=G/')).status, 400);
  const anon = client();
  assert.equal((await anon.get('/api/cases?q=GM/45/2026')).status, 401);
});

test('older records get their case numbers at start up', async () => {
  const r = await Record.collection.insertOne({ unitKey: 'hc2', formType: 'hearing-notice', status: 'final', data: { suitNumber: 'GM/77/2025' },
    createdBy: new mongoose.Types.ObjectId(u.clerk2.id), createdByName: 'Clerk Two', createdAt: new Date(), finalizedAt: new Date() });
  assert.equal((await u.clerk2.get('/api/cases?q=GM/77/2025')).body.cases.length, 0);
  await fillCaseNumbers(() => {});
  const found = await u.clerk2.get('/api/cases?q=GM/77/2025');
  assert.equal(found.body.cases[0].documents[0].id, String(r.insertedId));
});

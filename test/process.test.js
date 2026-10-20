/*
 * The Process Registry: filing with fees and receipt, official cases,
 * registration with suit numbers per type and year, the court rotation
 * (ordinary and EFCC), assignment by the Hon. Chief Judge, the slip's QR
 * check, and the court's Case Register.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_process';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const processSvc = require('../src/services/process');
const { Case, Unit } = require('../src/models');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
let server, base;
function client() {
  let cookie = '';
  async function call(method, p, body, raw) {
    const headers = { 'X-Requested-With': 'GSHC', ...(cookie ? { Cookie: cookie } : {}) };
    if (!raw) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p), upload: (p, form) => call('POST', p, null, form) };
}
const admin = client();
const u = {};
async function makeUser(spec) {
  const r = await admin.post('/api/admin/users', spec);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = client();
  await c.post('/api/auth/login', { username: spec.email, password: r.body.tempPassword });
  await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'Passw0rd123' });
  c.id = r.body.user.id;
  return c;
}
const filing = (over) => ({ caseType: 'civil', firstParty: 'Musa Bello', secondParty: 'Ali Sani', nature: 'Land', process: 'Writ of summons',
  counsel: 'A. B. Yusuf Esq.', filedOn: '2026-10-21', fees: [{ item: 'Writ of summons', qty: 1 }], receiptNumber: 'RC 1001', ...over });
async function uploadReceipt(id, buf = PDF, name = 'receipt.pdf') {
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  return u.clerk.upload(`/api/process/cases/${id}/receipt`, form);
}
async function fileAndRegister(over) {
  const r = await u.clerk.post('/api/process/cases', filing(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.case.id;
  if (!(over && (over.official || over.efcc))) assert.equal((await uploadReceipt(id)).status, 200);
  assert.equal((await u.clerk.post(`/api/process/cases/${id}/submit`)).status, 200);
  const reg = await u.registrar.post(`/api/process/cases/${id}/register`);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  return reg.body.case;
}

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  const staff = ['view', 'create', 'edit', 'finalize', 'print'];
  u.clerk = await makeUser({ fullName: 'Process Clerk', email: 'clerk@example.com', unitKeys: ['process'], privileges: staff });
  u.registrar = await makeUser({ fullName: 'Process Registrar', email: 'pr@example.com', unitKeys: ['process'], privileges: staff, signerRoles: ['process_registrar'] });
  u.cj = await makeUser({ fullName: 'Chief Judge', title: 'Hon. Justice', email: 'cj@example.com', signerRoles: ['chief_judge'] });
  u.court3 = await makeUser({ fullName: 'Court Three Clerk', email: 'hc3@example.com', unitKeys: ['hc3'], privileges: staff });
  await u.cj.post('/api/me/signature', { password: 'Passw0rd123', dataUrl: PNG });
  await u.cj.post('/api/me/signing-pin', { password: 'Passw0rd123', pin: '1357' });
  const s = await admin.put('/api/process/settings', { fees: [{ item: 'Writ of summons', amount: 5000 }, { item: 'Motion', amount: 1500 }], efccCourts: ['hc7', 'hc8'] });
  assert.equal(s.status, 200, JSON.stringify(s.body));
});
after(async () => { server.close(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('the Process Registry unit exists and settings have the three case types', async () => {
  assert.ok(await Unit.exists({ key: 'process', type: 'process' }));
  const s = await u.clerk.get('/api/process/settings');
  assert.deepEqual(s.body.caseTypes.map(t => `${t.label}:${t.suffix}`), ['Civil:', 'Criminal:c', 'Petition:p']);
  assert.equal(s.body.courts.length, 9);
  assert.equal(s.body.courts[8].roman, 'IX');
  assert.equal((await u.clerk.put('/api/process/settings', { prefix: 'XX' })).status, 403, 'administrators only');
  assert.equal((await admin.put('/api/process/settings', { caseTypes: [{ label: 'A', suffix: 'c' }, { label: 'B', suffix: 'c' }] })).status, 400, 'letters must differ');
});

test('fees come from the schedule; a filing needs its receipt before it goes to the Process Registrar', async () => {
  const r = await u.clerk.post('/api/process/cases', filing({ fees: [{ item: 'Writ of summons', qty: 1, amount: 1 }, { item: 'Motion', qty: 2 }] }));
  assert.equal(r.body.case.feeTotal, 8000, 'amounts from the schedule, not from the browser');
  const id = r.body.case.id;
  const s1 = await u.clerk.post(`/api/process/cases/${id}/submit`);
  assert.equal(s1.status, 400);
  assert.match(s1.body.error, /Upload the payment receipt/);
  const bad = await uploadReceipt(id, Buffer.from('not a receipt'), 'x.txt');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /photo \(PNG or JPEG\) or a PDF/);
  assert.equal((await uploadReceipt(id)).status, 200);
  assert.equal((await u.clerk.post(`/api/process/cases/${id}/submit`)).status, 200);
  assert.equal((await u.clerk.post(`/api/process/cases/${id}/register`)).status, 403, 'only the Process Registrar registers');
  const rec = await u.registrar.get(`/api/process/cases/${id}/receipt`);
  assert.equal(rec.status, 200);
  assert.equal(rec.headers.get('content-type'), 'application/pdf');
  assert.equal((await u.court3.get(`/api/process/cases/${id}/receipt`)).status, 403);
  // Returned with a comment, then corrected and sent again.
  const ret = await u.registrar.post(`/api/process/cases/${id}/return`, { comment: 'Receipt number does not match' });
  assert.equal(ret.body.case.status, 'returned');
  assert.equal((await u.clerk.put(`/api/process/cases/${id}`, { receiptNumber: 'RC 1002' })).status, 200);
  assert.equal((await u.clerk.post(`/api/process/cases/${id}/submit`)).status, 200);
  await Case.deleteOne({ _id: id });
});

test('suit numbers: each type counts on its own from 1, GM/1/2026, GM/1c/2026, GM/1p/2026', async () => {
  const year = new Date().getFullYear();
  const a = await fileAndRegister();
  const b = await fileAndRegister();
  const c = await fileAndRegister({ caseType: 'criminal', official: true, firstParty: 'The State', secondParty: 'Yakubu Adamu' });
  const p = await fileAndRegister({ caseType: 'petition' });
  assert.equal(a.suitNumber, `GM/1/${year}`);
  assert.equal(b.suitNumber, `GM/2/${year}`);
  assert.equal(c.suitNumber, `GM/1c/${year}`);
  assert.equal(p.suitNumber, `GM/1p/${year}`);
  assert.equal(c.official, true);
  assert.equal(c.feeTotal, 0, 'official: no fee');
  assert.equal(processSvc.formatHtml(c.suitNumber), `GM/1<sup>c</sup>/${year}`);
  // Next year starts again at 1.
  const next = await processSvc.nextNumber('civil', new Date(year + 1, 0, 2));
  assert.equal(next.suitNumber, `GM/1/${year + 1}`);
});

test('rotation: each case is proposed for the next court; EFCC matters go round the EFCC courts', async () => {
  const proposed = (await Case.find({ status: 'awaiting_assignment' }).sort({ registeredAt: 1 })).map(c => c.proposedUnit);
  assert.deepEqual(proposed, ['hc1', 'hc2', 'hc3', 'hc4']);
  const e1 = await fileAndRegister({ efcc: true, caseType: 'criminal', firstParty: 'FRN', secondParty: 'X' });
  const e2 = await fileAndRegister({ efcc: true, caseType: 'criminal', firstParty: 'FRN', secondParty: 'Y' });
  const e3 = await fileAndRegister({ efcc: true, caseType: 'criminal', firstParty: 'FRN', secondParty: 'Z' });
  assert.deepEqual([e1.proposed.key, e2.proposed.key, e3.proposed.key], ['hc7', 'hc8', 'hc7']);
  assert.equal(e1.official, true, 'EFCC matters are official');
  const next = await fileAndRegister();
  assert.equal(next.proposed.key, 'hc5', 'ordinary cases are not moved by EFCC ones');
});

test('the Chief Judge assigns with their PIN; the rotation continues from the court proposed', async () => {
  const list = await u.cj.get('/api/process/cases?status=awaiting_assignment');
  assert.ok(list.body.cases.length >= 7);
  const first = list.body.cases.find(c => c.proposed.key === 'hc1');
  assert.equal((await u.registrar.post(`/api/process/cases/${first.id}/assign`, { unitKey: 'hc1', pin: '1357' })).status, 403, 'only the Chief Judge assigns');
  assert.equal((await u.cj.post(`/api/process/cases/${first.id}/assign`, { unitKey: 'hc3', pin: '0000' })).status, 400, 'wrong PIN');
  const a = await u.cj.post(`/api/process/cases/${first.id}/assign`, { unitKey: 'hc3', pin: '1357' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.case.assigned.key, 'hc3', 'the Chief Judge may choose another court');
  assert.equal(a.body.case.assigned.roman, 'III');
  assert.ok(a.body.case.verifyCode);
  const after = await fileAndRegister();
  assert.equal(after.proposed.key, 'hc6', 'the rotation is not moved by the choice of court');

  // The slip's QR code checks as genuine, naming the court and the signer.
  const v = await fetch(`${base}/api/verify/${a.body.case.verifyCode}`).then(r => r.json());
  assert.equal(v.status, 'valid');
  assert.match(v.document, /High Court No\. III/);
  assert.equal(v.signedBy[0].name, 'Chief Judge');
  const full = await u.clerk.get(`/api/process/cases/${first.id}`);
  assert.match(full.body.case.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal((await u.clerk.get(full.body.case.signatureUrl.replace('/api', '/api'))).status, 200);
  assert.equal((await u.cj.post(`/api/process/cases/${first.id}/assign`, { pin: '1357' })).status, 409, 'assigned once');
});

test('the court sees its new case, marks the file received and records the disposal; earlier cases can be added', async () => {
  const reg = await u.court3.get('/api/process/register?unitKey=hc3');
  assert.equal(reg.status, 200);
  assert.equal(reg.body.cases.length, 1);
  const c = reg.body.cases[0];
  assert.equal(c.status, 'assigned');
  assert.equal((await u.court3.get('/api/process/register?unitKey=hc4')).status, 403, 'only its own court');
  assert.equal((await u.court3.post(`/api/process/cases/${c.id}/received`)).body.case.status, 'received');
  const d1 = await u.court3.post(`/api/process/cases/${c.id}/disposal`, { remark: 'Other', other: '' });
  assert.equal(d1.status, 400, 'Other needs words');
  const d = await u.court3.post(`/api/process/cases/${c.id}/disposal`, { remark: 'Judgment entered', date: '2026-12-01' });
  assert.equal(d.body.case.status, 'disposed');
  assert.equal(d.body.case.disposal.remark, 'Judgment entered');
  const o = await u.court3.post(`/api/process/cases/${c.id}/disposal`, { remark: 'Other', other: 'Settled out of court' });
  assert.equal(o.body.case.disposal.remark, 'Settled out of court', 'a remark can be corrected');

  const e = await u.court3.post('/api/process/register/earlier', { unitKey: 'hc3', suitNumber: 'GM/77/2024', nature: 'Contract', firstParty: 'A', secondParty: 'B', filedOn: '2024-03-01', assignedOn: '2024-03-05' });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.case.earlier, true);
  assert.equal((await u.court3.post('/api/process/register/earlier', { unitKey: 'hc3', suitNumber: 'GM/77/2024' })).status, 409, 'no duplicates');
  assert.equal((await u.court3.get('/api/process/register?unitKey=hc3')).body.cases.length, 2);

  // The Case File finds the case and its assignment.
  const cf = await u.court3.get(`/api/cases?q=${encodeURIComponent(c.suitNumber)}&exact=1`);
  assert.match(cf.body.cases[0].documents[0].formLabel, /Case disposed: Settled out of court/);
});

test('summary and counts for the Process Registry and the Chief Judge', async () => {
  const s = await u.registrar.get('/api/process/summary');
  assert.equal(s.status, 200);
  assert.ok(s.body.registered >= 9);
  assert.ok(s.body.official >= 4);
  assert.ok(s.body.fees >= 5000);
  assert.ok(s.body.byType.find(t => t.label === 'Criminal').count >= 4);
  assert.deepEqual(s.body.byCourt.map(c => c.name), ['High Court 3 Registry']);
  const counts = await u.cj.get('/api/process/counts');
  assert.ok(counts.body.awaitingAssignment >= 7);
  assert.equal((await u.court3.get('/api/process/summary')).status, 403);
  assert.equal((await u.court3.get('/api/process/cases')).status, 403);
});

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
  const early = await u.court3.post(`/api/process/cases/${c.id}/received`);
  assert.equal(early.status, 409, 'not before the Process Registry dispatches the file');
  assert.match(early.body.error, /still at the Process Registry/);
  assert.equal((await u.court3.post('/api/process/dispatch', { ids: [c.id] })).status, 403, 'only the Process Registry dispatches');
  const d0 = await u.clerk.post('/api/process/dispatch', { ids: [c.id] });
  assert.equal(d0.status, 200, JSON.stringify(d0.body));
  assert.equal(d0.body.cases[0].status, 'dispatched');
  assert.ok(d0.body.cases[0].dispatchedAt);
  assert.ok((await u.court3.get('/api/notifications')).body.notifications.some(n => /dispatched to your court/.test(n.message)), 'the court is told');
  assert.equal((await u.clerk.post('/api/process/dispatch', { ids: [c.id] })).status, 409, 'not twice');
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

test('two register books: each case type goes in the Civil or the Criminal book', async () => {
  const s = await u.clerk.get('/api/process/settings');
  assert.deepEqual(s.body.caseTypes.map(t => `${t.key}:${t.book}`), ['civil:civil', 'criminal:criminal', 'petition:civil']);
  const types = s.body.caseTypes.map(t => t.key === 'petition' ? { ...t, book: 'criminal' } : t);
  const saved = await admin.put('/api/process/settings', { caseTypes: types });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.caseTypes.find(t => t.key === 'petition').book, 'criminal');
  await admin.put('/api/process/settings', { caseTypes: s.body.caseTypes });

  const e = await u.court3.post('/api/process/register/earlier', { unitKey: 'hc3', caseType: 'criminal', suitNumber: 'GM/5c/2025', nature: 'Armed robbery',
    firstParty: 'The State', secondParty: 'X', filedOn: '2025-01-02', assignedOn: '2025-01-06', receivedOn: '2025-01-09' });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(new Date(e.body.case.receivedAt).getDate(), 9, 'the date the file was received, as typed');
});

test('the Process Registrar alone (without the unit) files a case and registers it straight to the Chief Judge', async () => {
  const pr = await makeUser({ fullName: 'Second Registrar', email: 'pr2@example.com', signerRoles: ['process_registrar'] });
  const units = await pr.get('/api/catalogue/units');
  assert.ok(units.body.units.some(x => x.key === 'process'), 'the Process Registry is in their menu');
  const r = await pr.post('/api/process/cases', filing({ official: true, caseType: 'criminal', firstParty: 'The State' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const reg = await pr.post(`/api/process/cases/${r.body.case.id}/register`);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.case.status, 'awaiting_assignment', 'no need to send it to themselves first');
});

test('the invoice: the fees chosen and the total, with a reference kept when issued again', async () => {
  const r = await u.clerk.post('/api/process/cases', filing({ firstParty: 'Invoice Payer', fees: [{ item: 'Writ of summons', qty: 1 }, { item: 'Motion', qty: 2 }], receiptNumber: '' }));
  const id = r.body.case.id;
  const i1 = await u.clerk.post(`/api/process/cases/${id}/invoice`);
  assert.equal(i1.status, 200, JSON.stringify(i1.body));
  const year = new Date().getFullYear();
  assert.equal(i1.body.case.invoice.reference, `INV/${year}/0001`);
  assert.equal(i1.body.case.invoice.total, 8000);
  assert.equal(i1.body.case.invoice.fees.length, 2);
  await u.clerk.put(`/api/process/cases/${id}`, { fees: [{ item: 'Writ of summons', qty: 1 }] });
  const i2 = await u.clerk.post(`/api/process/cases/${id}/invoice`);
  assert.equal(i2.body.case.invoice.reference, `INV/${year}/0001`, 'the same reference');
  assert.equal(i2.body.case.invoice.total, 5000, 'the new fees');
  const found = await u.clerk.get(`/api/process/cases?status=&q=${encodeURIComponent(`INV/${year}/0001`)}`);
  assert.equal(found.body.cases.length, 1, 'found by the invoice reference');
  const o = await u.clerk.post('/api/process/cases', filing({ official: true }));
  assert.equal((await u.clerk.post(`/api/process/cases/${o.body.case.id}/invoice`)).status, 400, 'official cases have no invoice');
  assert.equal((await u.cj.post(`/api/process/cases/${id}/invoice`)).status, 403);
  const next = await u.clerk.post('/api/process/cases', filing({ firstParty: 'Second Payer' }));
  assert.equal((await u.clerk.post(`/api/process/cases/${next.body.case.id}/invoice`)).body.case.invoice.reference, `INV/${year}/0002`);
});

test('the receipt upload can be made optional; the receipt number is still needed', async () => {
  const r = await u.clerk.post('/api/process/cases', filing({ firstParty: 'No Upload', receiptNumber: '' }));
  const id = r.body.case.id;
  assert.match((await u.clerk.post(`/api/process/cases/${id}/submit`)).body.error, /receipt number/);
  await u.clerk.put(`/api/process/cases/${id}`, { receiptNumber: 'RC 77' });
  assert.match((await u.clerk.post(`/api/process/cases/${id}/submit`)).body.error, /Upload the payment receipt/);
  const s = await admin.put('/api/process/settings', { receiptRequired: false, paymentNote: 'Pay at the cash office.' });
  assert.equal(s.body.receiptRequired, false);
  assert.equal(s.body.paymentNote, 'Pay at the cash office.');
  assert.equal((await u.clerk.post(`/api/process/cases/${id}/submit`)).status, 200);
  await admin.put('/api/process/settings', { receiptRequired: true });
});

test('new cases: on the court\'s Home and menu badge; the Chief Judge who assigns is not told as a member of that court', async () => {
  const cjhc = await makeUser({ fullName: 'Chief Judge Five', title: 'Hon. Justice', email: 'cj5@example.com', unitKeys: ['hc5'], signerRoles: ['judge', 'chief_judge'] });
  await cjhc.post('/api/me/signature', { password: 'Passw0rd123', dataUrl: PNG });
  await cjhc.post('/api/me/signing-pin', { password: 'Passw0rd123', pin: '2468' });
  const clerk5 = await makeUser({ fullName: 'Court Five Clerk', email: 'hc5@example.com', unitKeys: ['hc5'], privileges: ['view', 'create', 'edit'] });
  assert.equal((await clerk5.get('/api/process/counts')).body.newCases, 0);
  const c = await fileAndRegister({ firstParty: 'Badge Case' });
  const a = await cjhc.post(`/api/process/cases/${c.id}/assign`, { unitKey: 'hc5', pin: '2468' });
  assert.equal(a.status, 200, JSON.stringify(a.body));

  assert.equal((await clerk5.get('/api/process/counts')).body.newCases, 0, 'the count is of files dispatched, waiting to be received');
  assert.equal((await clerk5.get('/api/process/new-cases')).body.cases[0].status, 'assigned', 'Home lists it, the file still at the Process Registry');
  await u.clerk.post('/api/process/dispatch', { ids: [c.id] });
  assert.equal((await clerk5.get('/api/process/counts')).body.newCases, 1);
  const nc = await clerk5.get('/api/process/new-cases');
  assert.deepEqual(nc.body.cases.map(x => x.firstParty), ['Badge Case']);
  assert.ok((await clerk5.get('/api/notifications')).body.notifications.some(n => /assigned to your court/.test(n.message)));
  assert.ok(!(await cjhc.get('/api/notifications')).body.notifications.some(n => /assigned to your court/.test(n.message)), 'not to the Chief Judge who assigned it');
  assert.equal((await u.court3.get('/api/process/new-cases')).body.cases.some(x => x.firstParty === 'Badge Case'), false, 'only its own court');

  await clerk5.post(`/api/process/cases/${c.id}/received`);
  assert.equal((await clerk5.get('/api/process/counts')).body.newCases, 0, 'gone once the file is received');
});

test('several files dispatched at once; each court told of its own', async () => {
  const a = await fileAndRegister({ firstParty: 'Batch One' });
  const b = await fileAndRegister({ firstParty: 'Batch Two' });
  assert.equal((await u.cj.post(`/api/process/cases/${a.id}/assign`, { unitKey: 'hc2', pin: '1357' })).status, 200);
  assert.equal((await u.cj.post(`/api/process/cases/${b.id}/assign`, { unitKey: 'hc6', pin: '1357' })).status, 200);
  const r = await u.clerk.post('/api/process/dispatch', { ids: [a.id, b.id, 'not-an-id'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dispatched, 2);
  const listed = await u.clerk.get('/api/process/cases?status=dispatched');
  assert.ok(['Batch One', 'Batch Two'].every(p => listed.body.cases.some(c => c.firstParty === p)));
  assert.equal((await u.clerk.post('/api/process/dispatch', { ids: [] })).status, 400);
});

test('email updates to parties and counsel at each stage, noted on the case', async () => {
  const mail = require('../src/services/mail');
  const bad = await u.clerk.post('/api/process/cases', filing({ emails: { firstParty: 'not-an-email' } }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not a valid email address/);
  const start = mail.sent.length;
  const ours = ['party@example.com', 'party2@example.com', 'counsel@example.com'];
  const toParties = () => mail.sent.slice(start).filter(m => ours.includes(m.to));
  const r = await u.clerk.post('/api/process/cases', filing({ firstParty: 'Email Party', emails: { firstParty: 'party@example.com, Party2@Example.com', secondParty: '', counsel: 'counsel@example.com' } }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.case.emails.firstParty, ['party@example.com', 'party2@example.com']);
  const id = r.body.case.id;
  await u.clerk.post(`/api/process/cases/${id}/invoice`);
  const inv = toParties();
  assert.equal(inv.length, 3, 'invoice to each address');
  assert.match(inv[0].subject, /Invoice for your filing/);
  assert.match(inv[0].text, /INV\/\d{4}\/\d{4}/);
  await uploadReceipt(id);
  await u.clerk.post(`/api/process/cases/${id}/submit`);
  const reg = await u.registrar.post(`/api/process/cases/${id}/register`);
  const num = reg.body.case.suitNumber;
  assert.ok(toParties().some(m => m.subject.includes(`Case registered as ${num}`)));
  await u.cj.post(`/api/process/cases/${id}/assign`, { unitKey: 'hc3', pin: '1357' });
  assert.ok(toParties().some(m => m.subject.includes(`${num} assigned to High Court No. III`)));
  await u.clerk.post('/api/process/dispatch', { ids: [id] });
  await u.court3.post(`/api/process/cases/${id}/received`);
  const all = toParties();
  assert.equal(all.length, 12, 'four stages, three addresses');
  assert.ok(all.some(m => /file received at High Court No\. III/.test(m.subject)));
  assert.ok(all.every(m => !/Writ of summons|RC 1001/.test(m.text)), 'no fees or receipt details beyond the invoice');
  const view = await u.court3.get(`/api/process/cases/${id}`);
  assert.equal(view.status, 200, 'the court can open the case');
  assert.deepEqual([...new Set(view.body.case.emailLog.map(e => e.stage))], ['invoice', 'registered', 'assigned', 'received']);

  await admin.put('/api/process/settings', { partyEmails: false });
  const n = mail.sent.filter(m => m.to === 'counsel@example.com').length;
  const r2 = await u.clerk.post('/api/process/cases', filing({ emails: { counsel: 'counsel@example.com' } }));
  await u.clerk.post(`/api/process/cases/${r2.body.case.id}/invoice`);
  assert.equal(mail.sent.filter(m => m.to === 'counsel@example.com').length, n, 'switched off in Settings');
  await admin.put('/api/process/settings', { partyEmails: true });
});

test('scanned documents: added by the Process Registry and the assigned court, opened by those who see the case', async () => {
  const c = await fileAndRegister({ firstParty: 'Docs Party' });
  const add = (client, id, fields, buf = PDF, name = 'writ.pdf') => {
    const form = new FormData();
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    form.append('file', new Blob([buf]), name);
    return client.upload(`/api/process/cases/${id}/documents`, form);
  };
  const d1 = await add(u.clerk, c.id, { docType: 'Writ of summons', filedOn: '2026-10-21' });
  assert.equal(d1.status, 201, JSON.stringify(d1.body));
  assert.equal(d1.body.document.title, 'Writ of summons', 'the type when no title is given');
  assert.equal(d1.body.document.canDelete, true);
  assert.equal((await add(u.clerk, c.id, { docType: 'Others', other: '' })).status, 400, 'a title or a type is needed');
  assert.equal((await add(u.clerk, c.id, { docType: 'Motion' }, Buffer.from('not a pdf'), 'x.exe')).status, 400, 'PDF or photo only');
  assert.equal((await add(u.clerk, c.id, { docType: 'Exhibit' }, Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]))).status, 400, 'under 10 MB');
  assert.equal((await add(u.court3, c.id, { docType: 'Motion' })).status, 403, 'not yet the court\'s case');

  assert.equal((await u.cj.post(`/api/process/cases/${c.id}/assign`, { unitKey: 'hc3', pin: '1357' })).status, 200);
  const d2 = await add(u.court3, c.id, { docType: 'Others', other: 'Notice of appeal', title: 'Notice of appeal filed by the defendant', filedOn: '2026-11-02' });
  assert.equal(d2.status, 201, JSON.stringify(d2.body));
  const list = await u.court3.get(`/api/process/cases/${c.id}/documents`);
  assert.deepEqual(list.body.documents.map(d => d.title), ['Writ of summons', 'Notice of appeal filed by the defendant']);
  assert.equal(list.body.canUpload, true);
  assert.equal(list.body.documents[0].canDelete, false, 'only the uploader deletes');
  const file = await u.cj.get(list.body.documents[1].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  const other = await makeUser({ fullName: 'Court Four Clerk', email: 'hc4@example.com', unitKeys: ['hc4'], privileges: ['view', 'create'] });
  assert.equal((await other.get(list.body.documents[0].url)).status, 403, 'other courts cannot open them');

  const cf = await u.court3.get(`/api/cases?q=${encodeURIComponent(c.suitNumber)}&exact=1`);
  const scans = cf.body.cases[0].documents.filter(d => d.formType === 'scan');
  assert.equal(scans.length, 2, 'in the Case File');
  assert.ok(scans.every(d => d.fileUrl));
  const cf4 = await other.get(`/api/cases?q=${encodeURIComponent(c.suitNumber)}&exact=1`);
  assert.ok(cf4.body.cases[0].documents.filter(d => d.formType === 'scan').every(d => !d.fileUrl), 'listed but not openable for other courts');

  assert.equal((await u.clerk.del(`/api/process/documents/${list.body.documents[1].id}`)).status, 403);
  assert.equal((await u.court3.del(`/api/process/documents/${list.body.documents[1].id}`)).status, 200);
  assert.equal((await u.court3.get(`/api/process/cases/${c.id}/documents`)).body.documents.length, 1);
});

test('court diary: dates for register cases and typed ones, shared with the judge, limits, outcomes, emails, Home dates', async () => {
  const mail = require('../src/services/mail');
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const c = await fileAndRegister({ firstParty: 'Diary Party', emails: { counsel: 'diary@example.com' } });
  await u.cj.post(`/api/process/cases/${c.id}/assign`, { unitKey: 'hc3', pin: '1357' });
  const judge3 = await makeUser({ fullName: 'Judge Three', title: 'Hon. Justice', email: 'judge3@example.com', unitKeys: ['hc3'], signerRoles: ['judge'] });
  const before = mail.sent.filter(m => m.to === 'diary@example.com').length;

  const s = await admin.put('/api/process/settings', { businessTypes: ['Mention', 'Hearing', 'Continuation of hearing', 'Ruling', 'Judgment', 'Report of service', 'Adoption of written addresses'] });
  assert.equal(s.body.businessTypes.length, 7);

  const e1 = await u.court3.post('/api/diary', { unitKey: 'hc3', caseId: c.id, date: inDays(3), time: '09:00', business: 'Mention' });
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  assert.equal(e1.body.entry.suitNumber, c.suitNumber);
  assert.match(e1.body.entry.parties, /Diary Party v\. Ali Sani/);
  assert.ok(mail.sent.filter(m => m.to === 'diary@example.com').slice(before).some(m => /date fixed/.test(m.subject)), 'counsel told of the date');

  const typed = await judge3.post('/api/diary', { unitKey: 'hc3', suitNumber: 'GM/12/2019', parties: 'A v. B', date: inDays(3), business: 'Others', other: 'Hearing of motion' });
  assert.equal(typed.status, 201, 'the judge writes in the diary too, and a case not in the register can be typed');
  assert.equal(typed.body.entry.business, 'Hearing of motion');
  const seen = await u.court3.get(`/api/diary?unitKey=hc3&from=${inDays(3)}`);
  assert.equal(seen.body.entries.length, 2, 'the registry sees what the judge entered');
  assert.equal((await u.clerk.get(`/api/diary?unitKey=hc3&from=${inDays(3)}`)).status, 403, 'not for other units');
  assert.equal((await u.court3.post('/api/diary', { unitKey: 'hc3', caseId: c.id, date: inDays(4) })).status, 400, 'the business is needed');

  await admin.put('/api/process/settings', { dailyLimit: 2 });
  const full = await u.court3.post('/api/diary', { unitKey: 'hc3', suitNumber: 'GM/13/2019', date: inDays(3), business: 'Mention' });
  assert.equal(full.status, 409);
  assert.equal(full.body.full, true);
  assert.equal((await u.court3.post('/api/diary', { unitKey: 'hc3', suitNumber: 'GM/13/2019', date: inDays(3), business: 'Mention', force: true })).status, 201, 'fixed anyway when told to');
  await admin.put('/api/process/settings', { dailyLimit: 0 });

  const moved = await u.court3.put(`/api/diary/${e1.body.entry.id}`, { date: inDays(5) });
  assert.equal(moved.body.entry.date, inDays(5));
  assert.ok(mail.sent.filter(m => m.to === 'diary@example.com').slice(before).some(m => /date changed/.test(m.subject)));

  const home = await u.court3.get('/api/hearings?days=14');
  assert.ok(home.body.hearings.some(h => h.diaryId === e1.body.entry.id && h.what === 'Mention'), 'on Home with the other court dates');

  assert.equal((await u.court3.post(`/api/diary/${e1.body.entry.id}/outcome`, { outcome: 'Too soon' })).status, 409, 'not before the sitting');
  await u.court3.put(`/api/diary/${e1.body.entry.id}`, { date: inDays(-6) }); // entered after the event
  assert.equal((await u.court3.post(`/api/diary/${e1.body.entry.id}/outcome`, {})).status, 400, 'say what happened');
  const o = await judge3.post(`/api/diary/${e1.body.entry.id}/outcome`, { outcome: 'Parties present. Adjourned for hearing.', nextDate: inDays(-2), nextTime: '10:00', nextBusiness: 'Hearing' });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.entry.status, 'done');
  assert.equal(o.body.next.business, 'Hearing');
  assert.equal(o.body.next.date, inDays(-2));
  assert.equal((await u.court3.put(`/api/diary/${e1.body.entry.id}`, { date: inDays(6) })).status, 409, 'a sitting done stays as recorded');

  const end = await u.court3.post(`/api/diary/${o.body.next.id}/outcome`, { outcome: 'Judgment delivered.', disposal: 'Judgment entered' });
  assert.equal(end.status, 200);
  const cs = await u.court3.get(`/api/process/cases/${c.id}`);
  assert.equal(cs.body.case.status, 'disposed', 'the disposal reaches the Case Register');
  assert.equal(cs.body.case.disposal.remark, 'Judgment entered');
  const forCase = await u.court3.get(`/api/diary?unitKey=hc3&caseId=${c.id}`);
  assert.equal(forCase.body.entries.length, 2, 'the case\'s dates, for its View');

  assert.equal((await u.court3.del(`/api/diary/${typed.body.entry.id}`)).status, 200);
});

test('court statistics for the Chief Judge; Today in Court on Home', async () => {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = iso(new Date());
  assert.equal((await u.court3.get('/api/statistics')).status, 403, 'not for court staff');
  const from = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return iso(d); })();
  const s = await u.cj.get(`/api/statistics?from=${from < `${new Date().getFullYear()}-01-01` ? from : `${new Date().getFullYear()}-01-01`}&to=${today}`);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const hc3 = s.body.courts.find(c => c.key === 'hc3');
  assert.ok(hc3.assigned >= 3, 'cases assigned to High Court 3 this year');
  assert.ok(hc3.disposed >= 2, 'disposed of in the period, from the register and from the diary');
  assert.ok(hc3.pending >= 1);
  assert.ok(hc3.sittings >= 2, 'sittings recorded in the diary');
  assert.ok(hc3.adjournments >= 1);
  assert.equal(s.body.courts.length, 9);
  assert.equal(s.body.totals.pending, s.body.courts.reduce((n, c) => n + c.pending, 0));
  assert.equal(Object.values(hc3.bands).reduce((n, x) => n + x, 0), hc3.pending, 'every pending case in one band');
  assert.equal((await u.cj.get('/api/statistics?from=2026-12-01&to=2026-01-01')).status, 400);
  const p = await u.cj.get('/api/statistics/pending?unitKey=hc3');
  assert.equal(p.body.cases.length, hc3.pending);
  assert.ok(p.body.cases.every((c, i, a) => i === 0 || a[i - 1].years >= c.years), 'oldest first');
  assert.equal((await admin.get('/api/statistics')).status, 200, 'administrators too');

  const pend = p.body.cases.find(c => !c.earlier);
  const e = await u.court3.post('/api/diary', { unitKey: 'hc3', caseId: pend.id, date: today, time: '08:30', business: 'Mention' });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const t = await u.court3.get('/api/diary/today');
  const c3 = t.body.courts.find(c => c.key === 'hc3');
  assert.ok(c3.entries.some(x => x.id === e.body.entry.id));
  assert.equal(c3.canWrite, true);
  assert.ok(t.body.businessTypes.includes('Mention') && t.body.remarks.length);
  assert.deepEqual((await u.clerk.get('/api/diary/today')).body.courts, [], 'nothing for someone in no court');
});

test('register import: dates read day first, the parties split, the book chosen', () => {
  const imp = require('../src/services/registerImport');
  assert.equal(imp.readDate('12/03/2024'), '2024-03-12', 'day first');
  assert.equal(imp.readDate('5-1-21'), '2021-01-05');
  assert.equal(imp.readDate('12th March, 2024'), '2024-03-12');
  assert.equal(imp.readDate('12 Mar 2024'), '2024-03-12');
  assert.equal(imp.readDate('2024-03-12'), '2024-03-12');
  assert.equal(imp.readDate(45363), '2024-03-12', 'an Excel day number');
  assert.equal(imp.readDate(''), '');
  assert.equal(imp.readDate('31/02/2024'), null, 'no such day');
  assert.equal(imp.readDate('sometime'), null);
  assert.deepEqual(imp.splitParties('Musa Bello vs. Ali Sani'), ['Musa Bello', 'Ali Sani']);
  assert.deepEqual(imp.splitParties('The State v Yakubu Adamu & 2 Ors'), ['The State', 'Yakubu Adamu & 2 Ors']);
  const types = [{ key: 'civil', label: 'Civil', suffix: '', book: 'civil' }, { key: 'criminal', label: 'Criminal', suffix: 'c', book: 'criminal' }, { key: 'petition', label: 'Petition', suffix: 'p', book: 'civil' }];
  assert.equal(imp.caseTypeFor('Criminal', 'GM/9/2020', types).type.key, 'criminal');
  assert.equal(imp.caseTypeFor('', 'GM/45p/2023', types).type.key, 'petition', 'from the letter in the number');
  assert.equal(imp.caseTypeFor('', 'GM/45/2023', types).guessed, true);
  assert.deepEqual(Object.keys(imp.mapHeadings(['S/No', 'Register (Civil or Criminal)', 'Name of case', 'Suit number', 'Date of filing', 'Date of assignment', 'Type of case', 'Date received', 'Date of disposal', 'Remarks', 'Next date', 'Coming up for'])).sort(),
    ['assigned', 'business', 'disposal', 'filed', 'nature', 'nextDate', 'parties', 'received', 'register', 'remarks', 'sn', 'suit']);
});

test('register import from Excel and CSV: checked first, then saved, next dates into the diary', async () => {
  const { xlsx, serial } = require('./helpers/xlsx');
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const soon = (() => { const d = new Date(); d.setDate(d.getDate() + 10); return iso(d); })();
  const head = ['S/No', 'Register (Civil or Criminal)', 'Name of case', 'Suit number', 'Date of filing', 'Date of assignment', 'Type of case', 'Date received', 'Date of disposal', 'Remarks', 'Next date', 'Coming up for'];
  const book = xlsx([
    ['HIGH COURT 4 REGISTER'], head,
    [1, 'Civil', 'Adamu Musa v. Gombe Line Ltd', 'GM/101/2019', serial('2019-02-04'), serial('2019-02-11'), 'Contract', serial('2019-02-14'), '', '', soon, 'Hearing'],
    [2, 'Criminal', 'The State v. Bala Yusuf', 'GM/7c/2018', '03/05/2018', '10/05/2018', 'Theft', '11/05/2018', '20/01/2022', 'Accused discharged', '', ''],
    [3, '', 'Hauwa Ali v. Ibrahim Ali', 'GM/12p/2021', '', '', 'Divorce', '', '', '', '', ''],
    [4, 'Civil', 'No Number v. Anyone', '', '', '', '', '', '', '', '', ''],
    [5, 'Civil', 'Bad Date v. Someone', 'GM/55/2020', '31/02/2020', '', '', '', '', '', '', ''],
    [6, 'Civil', 'Twice v. Over', 'GM/101/2019', '', '', '', '', '', '', '', ''],
    []
  ]);
  const clerk4 = await makeUser({ fullName: 'Court Four Registry', email: 'reg4@example.com', unitKeys: ['hc4'], privileges: ['view', 'create', 'edit'] });
  const send = (client, buf, name, commit, unitKey = 'hc4') => {
    const form = new FormData();
    form.append('unitKey', unitKey); form.append('commit', commit ? '1' : '0'); form.append('file', new Blob([buf]), name);
    return client.upload('/api/process/register/import', form);
  };
  assert.equal((await send(u.court3, book, 'hc4.xlsx', false)).status, 403, 'only the court\'s own staff');
  const pre = await send(clerk4, book, 'hc4.xlsx', false);
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal(pre.body.preview, true);
  assert.equal(pre.body.toAdd, 3);
  assert.equal(pre.body.skipped, 3);
  const byLine = Object.fromEntries(pre.body.rows.map(r => [r.line, r]));
  assert.match(byLine[6].problems[0], /No suit number/);
  assert.match(byLine[7].problems[0], /Date of filing "31\/02\/2020" cannot be read/);
  assert.match(byLine[8].problems[0], /twice/);
  assert.equal(byLine[5].book, 'civil', 'a petition goes in the Civil book');
  assert.equal(byLine[4].status, 'Disposed of');
  assert.equal(byLine[3].next.date, soon);
  assert.equal(await Case.countDocuments({ suitNumber: 'GM/101/2019' }), 0, 'nothing saved by the check');

  const done = await send(clerk4, book, 'hc4.xlsx', true);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.added, 3);
  assert.equal(done.body.dates, 1);
  const reg = await clerk4.get('/api/process/register?unitKey=hc4');
  const civil = reg.body.cases.find(c => c.suitNumber === 'GM/101/2019');
  assert.equal(civil.firstParty, 'Adamu Musa');
  assert.equal(civil.secondParty, 'Gombe Line Ltd');
  assert.equal(civil.filedOn, '2019-02-04');
  assert.equal(new Date(civil.assignedAt).toISOString().slice(0, 10), '2019-02-11');
  const crim = reg.body.cases.find(c => c.suitNumber === 'GM/7c/2018');
  assert.equal(crim.status, 'disposed');
  assert.equal(crim.disposal.remark, 'Accused discharged');
  assert.equal(crim.disposal.date, '2022-01-20');
  const diary = await clerk4.get(`/api/diary?unitKey=hc4&from=${soon}`);
  assert.ok(diary.body.entries.some(e => e.suitNumber === 'GM/101/2019' && e.business === 'Hearing'));
  const again = await send(clerk4, book, 'hc4.xlsx', false);
  assert.equal(again.body.toAdd, 0, 'imported cases are not added twice');

  const csv = Buffer.from('﻿Suit number;Name of case;Register;Date received\r\n"GM/300/2017";"Gambo, Musa v. Ali";Criminal;"1 June 2017"\r\n');
  const c = await send(clerk4, csv, 'more.csv', true);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.added, 1);
  const g = (await clerk4.get('/api/process/register?unitKey=hc4')).body.cases.find(x => x.suitNumber === 'GM/300/2017');
  assert.equal(g.firstParty, 'Gambo, Musa');
  assert.equal(g.caseType, 'criminal');
  assert.equal((await send(clerk4, Buffer.from('a,b\r\n1,2'), 'x.csv', false)).body.error.includes('Suit number'), true, 'a sheet without the heading is refused');
  const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  assert.match((await send(clerk4, xls, 'old.xls', false)).body.error, /old Excel/);
});

test('fill a form from a case: its number, parties, addresses, court and judge; the diary date; choose a case', async () => {
  const r = await u.clerk.post('/api/process/cases', filing({ firstParty: 'Fill Plaintiff', secondParty: 'Fill Defendant', firstPartyAddress: 'No. 4 Bauchi Road, Gombe', secondPartyAddress: 'Pantami, Gombe', official: true }));
  assert.equal(r.body.case.firstPartyAddress, 'No. 4 Bauchi Road, Gombe', 'addresses kept at filing');
  const reg = await u.registrar.post(`/api/process/cases/${r.body.case.id}/register`);
  const id = reg.body.case.id, num = reg.body.case.suitNumber;
  await u.cj.post(`/api/process/cases/${id}/assign`, { unitKey: 'hc3', pin: '1357' });

  const civil = await u.court3.get(`/api/cases/fill?formType=civil-summons&caseId=${id}`);
  assert.equal(civil.status, 200, JSON.stringify(civil.body));
  const v = civil.body.values;
  assert.equal(v.suitNumber, num);
  assert.equal(v.plaintiff, 'Fill Plaintiff');
  assert.equal(v.defendant, 'Fill Defendant');
  assert.equal(v.plaintiffAddress, 'No. 4 Bauchi Road, Gombe');
  assert.equal(v.issuePlace, 'High Court No. 3', 'issued at: the court and its number');
  assert.ok(civil.body.replace.includes('issuePlace'), 'replacing the starting "Gombe"');

  const order = (await u.court3.get(`/api/cases/fill?formType=court-order&caseId=${id}`)).body.values;
  assert.equal(order.leftParties, 'Fill Plaintiff');
  assert.equal(order.rightParties, 'Fill Defendant');
  assert.equal(order.counselName, 'A. B. Yusuf Esq.');
  assert.equal(order.judgeName, 'Hon. Justice Judge Three', 'the court\'s one judge');
  assert.equal((await u.court3.get(`/api/cases/fill?formType=writ-attachment-goods&caseId=${id}`)).body.values.courtNumber, '3');

  const c = await fileAndRegister({ caseType: 'criminal', official: true, firstParty: 'The State', secondParty: 'Accused Person', nature: 'Theft', secondPartyAddress: 'Tumfure' });
  await u.cj.post(`/api/process/cases/${c.id}/assign`, { unitKey: 'hc3', pin: '1357' });
  const crim = (await u.court3.get(`/api/cases/fill?formType=criminal-summons&caseId=${c.id}`)).body.values;
  assert.equal(crim.complainant, 'The State');
  assert.equal(crim.accusedName, 'Accused Person');
  assert.equal(crim.accusedAddress, 'Tumfure');
  assert.equal(crim.offence, 'Theft', 'the nature of a criminal case as the offence');

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return iso(d); })();
  const e = await u.court3.post('/api/diary', { unitKey: 'hc3', caseId: id, date: day, time: '10:00', business: 'Hearing' });
  const hn = (await u.court3.get(`/api/cases/fill?formType=hearing-notice&diaryId=${e.body.entry.id}`)).body;
  assert.equal(hn.values.hearingDate, day);
  assert.equal(hn.values.hearingTime, '10:00');
  assert.equal(hn.values.suitNumber, num);
  assert.equal(hn.fromDiary, true);

  const found = await u.court3.get('/api/cases/registered?q=Fill Plain');
  assert.ok(found.body.cases.some(x => x.id === id && x.court === 'High Court No. 3'));
  const byNo = await u.court3.get(`/api/cases/fill?formType=civil-summons&caseNo=${encodeURIComponent(num.toLowerCase())}`);
  assert.equal(byNo.body.values.plaintiff, 'Fill Plaintiff', 'by suit number too (the Case File)');
  assert.equal((await u.court3.get('/api/cases/fill?formType=nothing&caseId=' + id)).status, 400);
});

test('summonses: the court to appear before is the court and its number; times start at 9:00', async () => {
  const catalogue = require('../src/forms/catalogue');
  const field = (form, name) => catalogue.forms[form].schema.find(f => f.name === name);
  assert.equal(field('civil-summons', 'courtPlace').defaultValue, undefined, 'no longer "High Court of Justice, Gombe"');
  assert.match(field('civil-summons', 'courtPlace').help, /High Court No\. 1/);
  assert.equal(field('criminal-summons', 'appearanceCourt').defaultValue, undefined);
  for (const [form, name] of [['civil-summons', 'appearanceTime'], ['criminal-summons', 'appearanceTime'], ['witness-summons', 'appearanceTime'], ['bail-bond', 'appearanceTime'], ['hearing-notice', 'hearingTime'], ['subpoena-ad-testificandum', 'attendanceTime'], ['order-to-produce-prisoner', 'productionTime']]) {
    assert.equal(field(form, name).defaultValue, '9:00', `${form}: ${name}`);
  }
  assert.equal(field('civil-summons', 'timePeriod').defaultValue, 'forenoon');

  const c = await fileAndRegister({ firstParty: 'Court Place Party' });
  await u.cj.post(`/api/process/cases/${c.id}/assign`, { unitKey: 'hc3', pin: '1357' });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = (() => { const d = new Date(); d.setDate(d.getDate() + 8); return iso(d); })();
  const e = await u.court3.post('/api/diary', { unitKey: 'hc3', caseId: c.id, date: day, time: '14:30', business: 'Hearing' });
  const r = (await u.court3.get(`/api/cases/fill?formType=civil-summons&diaryId=${e.body.entry.id}`)).body;
  assert.equal(r.values.courtPlace, 'High Court No. 3');
  assert.ok(r.replace.includes('courtPlace'));
  assert.equal(r.values.appearanceDate, day);
  assert.equal(r.values.appearanceTime, '2:30', 'as the form writes it');
  assert.equal(r.values.timePeriod, 'afternoon');
  assert.equal((await u.court3.get(`/api/cases/fill?formType=criminal-summons&caseId=${c.id}`)).body.values.appearanceCourt, 'High Court No. 3');
});

test('warrant of arrest and order to produce: the court to bring before is the court and its number', async () => {
  const catalogue = require('../src/forms/catalogue');
  const field = (form, name) => catalogue.forms[form].schema.find(f => f.name === name);
  assert.equal(field('warrant-of-arrest', 'courtToBringBefore').defaultValue, undefined);
  assert.equal(field('order-to-produce-prisoner', 'courtToProduceBefore').defaultValue, undefined);
  const c = await fileAndRegister({ caseType: 'criminal', official: true, firstParty: 'The State', secondParty: 'Warrant Accused' });
  await u.cj.post(`/api/process/cases/${c.id}/assign`, { unitKey: 'hc3', pin: '1357' });
  assert.equal((await u.court3.get(`/api/cases/fill?formType=warrant-of-arrest&caseId=${c.id}`)).body.values.courtToBringBefore, 'High Court No. 3');
  assert.equal((await u.court3.get(`/api/cases/fill?formType=order-to-produce-prisoner&caseId=${c.id}`)).body.values.courtToProduceBefore, 'High Court No. 3');
});

test('withdrawing the official fee schedule: an edited list is kept; it runs once', async () => {
  const mongoose = require('mongoose');
  const meta = mongoose.connection.collection('appmeta');
  await meta.deleteMany({ _id: { $in: ['officialFeesUndone:gombe-2023', 'officialFeesLoaded:gombe-2023', 'feesBefore:gombe-2023'] } });
  assert.equal(await processSvc.undoOfficialFeesOnce(() => {}), null, 'nothing to do where it was never loaded');
  await meta.deleteOne({ _id: 'officialFeesUndone:gombe-2023' });
  await meta.insertMany([{ _id: 'officialFeesLoaded:gombe-2023' }, { _id: 'feesBefore:gombe-2023', fees: [{ item: 'Old fee', amount: 1 }] }]);
  const now = (await processSvc.getSettings()).fees;
  assert.equal(await processSvc.undoOfficialFeesOnce(() => {}), 'kept', 'a list that is not exactly the official one stays');
  assert.deepEqual((await processSvc.getSettings()).fees, now);
  assert.equal(await processSvc.undoOfficialFeesOnce(() => {}), null, 'only once');
});

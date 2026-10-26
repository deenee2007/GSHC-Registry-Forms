/*
 * Leave: applied for from the officer's record (by the officer whose account
 * is linked, or by the registry), checked against the days left, through the
 * Staff Officer to the Director Personnel (or the Chief Registrar for senior
 * officers), each step signed with the PIN; approval gives the reference,
 * the record of service entry and the roster; decline and withdraw.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_leave';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const leaveSvc = require('../src/services/leave');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let server, base;
function client() {
  let cookie = '';
  async function call(method, p, body) {
    const headers = { 'X-Requested-With': 'GSHC', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b) };
}
const admin = client();
const u = {};
async function makeUser(spec, pin) {
  const r = await admin.post('/api/admin/users', spec);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = client();
  await c.post('/api/auth/login', { username: spec.email, password: r.body.tempPassword });
  await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'Passw0rd123' });
  if (pin) {
    await c.post('/api/me/signature', { password: 'Passw0rd123', dataUrl: PNG });
    await c.post('/api/me/signing-pin', { password: 'Passw0rd123', pin });
  }
  c.id = r.body.user.id;
  return c;
}
const staff = {};
before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  u.secret = await makeUser({ fullName: 'Secret Registry', email: 'sr@example.com', privileges: ['personnel_edit'] });
  u.so = await makeUser({ fullName: 'Staff Officer', email: 'so@example.com', signerRoles: ['staff_officer'] }, '1111');
  u.dp = await makeUser({ fullName: 'Director Personnel', email: 'dp@example.com', signerRoles: ['director_personnel'], privileges: ['personnel_view'] }, '2222');
  u.cr = await makeUser({ fullName: 'Chief Registrar', email: 'cr@example.com', signerRoles: ['chief_registrar'] }, '3333');
  u.officer = await makeUser({ fullName: 'Musa Clerk', email: 'musa@example.com', unitKeys: ['hc3'], privileges: ['view'] });
  const add = async (x) => (await u.secret.post('/api/personnel/staff', x)).body.staff;
  staff.musa = await add({ psn: '5001', name: 'Musa Clerk', sex: 'M', gl: '06', rank: 'Clerical Officer', station: 'High Court No. III', dob: '1980-01-01', dofa: '2005-01-01' });
  staff.senior = await add({ psn: '5002', name: 'Senior Officer', gl: '15', rank: 'Deputy Director', dob: '1975-01-01', dofa: '2000-01-01' });
  staff.retired = await add({ psn: '5003', name: 'Gone Home', gl: '07' });
  await u.secret.post(`/api/personnel/staff/${staff.retired.id}/events`, { kind: 'status', date: '2026-01-01', status: 'retired' });
  assert.equal((await admin.put(`/api/personnel/staff/${staff.musa.id}`, { user: u.officer.id })).status, 200, 'the administrator links the account');
});
after(async () => { server.close(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('dates: working days leave out weekends and holidays; the day to resume', () => {
  assert.deepEqual(leaveSvc.span('2026-10-30', 5, true, []), { from: '2026-10-30', to: '2026-11-05', resume: '2026-11-06' });
  assert.deepEqual(leaveSvc.span('2026-10-31', 3, true, ['2026-11-03']), { from: '2026-11-02', to: '2026-11-05', resume: '2026-11-06' }, 'starts on the Monday, skips the holiday');
  assert.equal(leaveSvc.span('2026-11-01', 112, false, []).to, '2027-02-20', 'calendar days for maternity leave');
  assert.equal(leaveSvc.allowed({ days: 'gl' }, { gl: '06' }, leaveSvc.DEFAULTS), 21);
  assert.equal(leaveSvc.allowed({ days: 'gl' }, { gl: '07' }, leaveSvc.DEFAULTS), 30);
  assert.deepEqual(leaveSvc.route({ gl: '15' }, leaveSvc.DEFAULTS).map(s => s.role), ['staff_officer', 'director_personnel', 'chief_registrar']);
  assert.deepEqual(leaveSvc.route({ gl: 'Cons.' }, leaveSvc.DEFAULTS).map(s => s.role), ['staff_officer', 'chief_judge']);
});

test('the officer applies for their own annual leave; Staff Officer forwards, Director Personnel approves; letter reference, record of service, roster', async () => {
  const me = await u.officer.get('/api/leave/me');
  assert.equal(me.body.staff.psn, '5001');
  const annual = me.body.balances.find(b => b.key === 'annual');
  assert.equal(annual.allowed, 21, 'GL 06: 21 days');
  assert.ok(me.body.balances.some(b => b.key === 'paternity') && !me.body.balances.some(b => b.key === 'maternity'), 'a male officer: paternity, not maternity');
  assert.equal((await u.officer.post('/api/leave', { staffId: staff.musa.id, type: 'maternity', from: '2026-11-02', days: 5 })).status, 400);
  assert.equal((await u.officer.post('/api/leave', { staffId: staff.senior.id, type: 'annual', from: '2026-11-02', days: 5 })).status, 403, 'not for another officer');
  assert.equal((await u.officer.post('/api/leave', { staffId: staff.musa.id, type: 'annual', from: '2026-11-02', days: 25 })).status, 400, 'more than is left');
  const r = await u.officer.post('/api/leave', { staffId: staff.musa.id, type: 'annual', from: '2026-11-02', days: 10, address: 'Kaltungo', relief: 'Hauwa Ali' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const l = r.body.leave;
  assert.equal(l.to, '2026-11-13'); assert.equal(l.resume, '2026-11-16');
  assert.deepEqual(l.steps.map(s => s.label), ['Staff Officer', 'Director Personnel']);
  assert.equal((await u.officer.post('/api/leave', { staffId: staff.musa.id, type: 'casual', from: '2026-11-05', days: 1 })).status, 409, 'no overlap');
  assert.equal((await u.so.get('/api/leave/counts')).body.waiting, 1);
  assert.ok((await u.so.get('/api/notifications')).body.notifications.some(n => n.kind === 'leave' && /applies for 10 working days of annual leave/.test(n.message)));
  assert.equal((await u.dp.post(`/api/leave/${l.id}/act`, { pin: '2222' })).status, 403, 'not yet the Director\'s step');
  assert.equal((await u.so.post(`/api/leave/${l.id}/act`, { pin: '0000' })).status, 400, 'wrong PIN');
  assert.equal((await u.so.post(`/api/leave/${l.id}/act`, { decision: 'decline' , pin: '1111' })).status, 400, 'a reason to decline');
  const f = await u.so.post(`/api/leave/${l.id}/act`, { pin: '1111', comment: 'Forwarded for approval' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.leave.waiting.label, 'Director Personnel');
  const a = await u.dp.post(`/api/leave/${l.id}/act`, { pin: '2222' });
  assert.equal(a.body.leave.status, 'approved');
  assert.match(a.body.leave.reference, /^GSHC\/PER\/LV\/2026\/0001$/);
  assert.equal((await u.officer.get(`/api/leave/${l.id}/signature`)).status, 200, 'the signature for the letter');
  assert.ok((await u.officer.get('/api/notifications')).body.notifications.some(n => /Approved: Musa Clerk/.test(n.message)));
  const rec = (await u.secret.get(`/api/personnel/staff/${staff.musa.id}`)).body.staff;
  assert.match(rec.history[0].text, /Annual leave approved: 10 working days, 2 November 2026 to 13 November 2026; resumes 16 November 2026/);
  assert.equal((await u.officer.get('/api/leave/me')).body.balances.find(b => b.key === 'annual').left, 11);
  const roster = await u.dp.get('/api/leave/roster?from=2026-11-05');
  assert.deepEqual(roster.body.leaves.map(x => x.psn), ['5001']);
  assert.equal((await u.officer.get('/api/leave/roster')).status, 403);
});

test('senior officers go on to the Chief Registrar; decline and withdraw; the registry applies; not for an officer out of service', async () => {
  const r = await u.secret.post('/api/leave', { staffId: staff.senior.id, type: 'annual', from: '2026-12-01', days: 30 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const l = r.body.leave;
  assert.deepEqual(l.steps.map(s => `${s.label}:${s.action}`), ['Staff Officer:Forward', 'Director Personnel:Recommend', 'Chief Registrar:Approve']);
  await u.so.post(`/api/leave/${l.id}/act`, { pin: '1111' });
  await u.dp.post(`/api/leave/${l.id}/act`, { pin: '2222' });
  const d = await u.cr.post(`/api/leave/${l.id}/act`, { decision: 'decline', comment: 'Year end returns are due', pin: '3333' });
  assert.equal(d.body.leave.status, 'declined');
  assert.ok((await u.secret.get('/api/notifications')).body.notifications.some(n => /declined .*Year end returns/.test(n.message)));
  const again = await u.secret.post('/api/leave', { staffId: staff.senior.id, type: 'casual', from: '2026-12-01', days: 2 });
  assert.equal(again.status, 201, 'declined leave does not block the days');
  assert.equal((await u.so.post(`/api/leave/${again.body.leave.id}/withdraw`)).status, 403);
  assert.equal((await u.secret.post(`/api/leave/${again.body.leave.id}/withdraw`)).body.leave.status, 'withdrawn');
  assert.equal((await u.secret.post('/api/leave', { staffId: staff.retired.id, type: 'annual', from: '2026-12-01', days: 2 })).status, 409, 'retired');
  const all = await u.dp.get('/api/leave?scope=all&year=2026');
  assert.equal(all.body.leaves.length, 3);
});

test('leave settings: the administrator sets the kinds of leave, days, the senior grade level and relief', async () => {
  assert.equal((await u.secret.put('/api/leave/settings', { reliefRequired: true })).status, 403);
  const s = await admin.put('/api/leave/settings', { reliefRequired: true, annualJunior: 20, seniorFromGl: '14', holidays: ['2026-12-25'] });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await u.officer.post('/api/leave', { staffId: staff.musa.id, type: 'casual', from: '2026-12-21', days: 2 })).status, 400, 'relief officer now needed');
  const c = await u.officer.post('/api/leave', { staffId: staff.musa.id, type: 'casual', from: '2026-12-24', days: 2, relief: 'Hauwa Ali' });
  assert.equal(c.body.leave.to, '2026-12-28', 'Christmas Day is a holiday');
  assert.equal((await admin.put('/api/leave/settings', { types: [{ name: 'Annual leave', key: 'annual', days: 'x' }] })).status, 400);
});

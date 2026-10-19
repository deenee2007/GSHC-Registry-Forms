/*
 * Hearing reminders: court dates read from signed documents, the Home page
 * list, and the email sent the working day before.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_hearings';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll, fillCaseNumbers } = require('../src/services/seed');
const catalogue = require('../src/forms/catalogue');
const hearings = require('../src/services/hearings');
const mail = require('../src/services/mail');
const settings = require('../src/services/settings');
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
const iso = hearings.iso;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
let creator;
async function signed(unitKey, formType, data, status = 'final') {
  const d = catalogue.describe(formType, data);
  return Record.create({ unitKey, formType, status, data, ...d, createdBy: creator, createdByName: 'Clerk', finalizedAt: status === 'final' ? new Date() : undefined });
}

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  const privileges = ['view', 'create', 'edit', 'finalize', 'print'];
  u.clerk = await makeUser({ username: 'clerk1', fullName: 'Clerk One', email: 'clerk1@example.com', unitKeys: ['hc1'], privileges });
  u.judge = await makeUser({ username: 'judge1', fullName: 'Judge One', email: 'judge1@example.com', unitKeys: ['hc1'], signerRoles: ['judge'] });
  u.clerk2 = await makeUser({ username: 'clerk2', fullName: 'Clerk Two', email: 'clerk2@example.com', unitKeys: ['hc2'], privileges });
  u.quiet = await makeUser({ username: 'quiet', fullName: 'Quiet One', email: 'quiet@example.com', unitKeys: ['hc1'], privileges });
  await User.updateOne({ username: 'quiet' }, { $set: { emailAlerts: false } });
  creator = u.clerk.id;
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('court dates are read from the forms that fix one', () => {
  assert.deepEqual(catalogue.courtDates('hearing-notice', { hearingDate: '2026-11-02', hearingTime: '9:00', stage: 'Mention' }),
    [{ date: '2026-11-02', time: '9:00', what: 'Hearing (Mention)' }]);
  assert.equal(catalogue.courtDates('cause-list', { sittingDate: '2026-11-02', entries: [{}, {}] })[0].what, 'Court sitting: cause list of 2 case(s)');
  assert.equal(catalogue.courtDates('remand-warrant', { returnDate: '2026-11-09' })[0].time, '');
  assert.deepEqual(catalogue.courtDates('hearing-notice', { hearingDate: '' }), []);
  assert.deepEqual(catalogue.courtDates('affidavit-of-means', { swornDate: '2026-11-02' }), [], 'not every date is a court date');
});

test('the Home list shows signed court dates for the user\'s own courts, soonest first', async () => {
  await signed('hc1', 'hearing-notice', { suitNumber: 'GM/45/2026', plaintiff: 'Musa Bello', hearingDate: inDays(2), hearingTime: '10:30', stage: 'Hearing' });
  await signed('hc1', 'civil-summons', { suitNumber: 'GM/46/2026', plaintiff: 'Ada Yusuf', appearanceDate: inDays(2), appearanceTime: '9:00' });
  await signed('hc1', 'witness-summons', { caseNumber: 'GM/47/2026', appearanceDate: inDays(30) });
  await signed('hc1', 'hearing-notice', { suitNumber: 'GM/48/2026', hearingDate: inDays(3) }, 'pending');
  await signed('hc2', 'hearing-notice', { suitNumber: 'GM/90/2026', plaintiff: 'Other Court', hearingDate: inDays(1), hearingTime: '9:00' });

  const r = await u.clerk.get('/api/hearings?days=14');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.hearings.map(h => h.caseNo), ['GM/46/2026', 'GM/45/2026'], 'own court, signed only, within 14 days, by time');
  assert.equal(r.body.hearings[1].what, 'Hearing (Hearing)');
  assert.equal(r.body.hearings[0].parties, 'Ada Yusuf');
  assert.ok(r.body.hearings[0].id);

  const all = await admin.get('/api/hearings?days=14');
  assert.deepEqual(all.body.hearings.map(h => h.caseNo), ['GM/90/2026', 'GM/46/2026', 'GM/45/2026'], 'administrators see every court');
  assert.equal((await u.clerk.get('/api/hearings?unitKey=hc2')).status, 403);
  assert.equal((await u.clerk.get(`/api/hearings?from=${inDays(29)}&days=3`)).body.hearings.length, 1, 'any period');
});

test('the next court day skips the weekend', () => {
  const day = (y, m, d) => new Date(y, m - 1, d, 8);
  assert.equal(hearings.nextCourtDay(day(2026, 10, 19)), '2026-10-20'); // Monday → Tuesday
  assert.equal(hearings.nextCourtDay(day(2026, 10, 23)), '2026-10-26'); // Friday → Monday
  assert.equal(hearings.nextCourtDay(day(2026, 10, 24)), null);          // Saturday
  assert.equal(hearings.nextCourtDay(day(2026, 10, 25)), null);          // Sunday
  assert.equal(hearings.minutes('2:30pm') > hearings.minutes('10:00'), true);
});

test('the day before, each court\'s people are emailed its dates, once', async () => {
  await Record.deleteMany({});
  // A Thursday: reminders are for Friday.
  const thursday = new Date(2026, 9, 22, 7, 5);
  await signed('hc1', 'hearing-notice', { suitNumber: 'GM/45/2026', plaintiff: 'Musa Bello', defendant: 'Ali Sani', hearingDate: '2026-10-23', hearingTime: '9:00', stage: 'Mention' });
  await signed('hc1', 'subpoena-ad-testificandum', { suitNumber: 'GM/46/2026', plaintiff: 'Ada Yusuf', attendanceDate: '2026-10-23', attendanceTime: '11:00' });
  await signed('hc2', 'cause-list', { sittingDate: '2026-10-23', sittingTime: '9:00', entries: [{ suitNumber: 'GM/90/2026' }] });
  await signed('hc1', 'hearing-notice', { suitNumber: 'GM/49/2026', hearingDate: '2026-10-26' }); // not tomorrow

  assert.equal(await hearings.sendDigest(new Date(2026, 9, 22, 6, 30)), null, 'not before 07:00');
  const start = mail.sent.length;
  const r = await hearings.sendDigest(thursday);
  assert.deepEqual(r, { day: '2026-10-23', items: 3, sent: 3 });
  const sent = mail.sent.slice(start);
  assert.deepEqual(sent.map(m => m.to).sort(), ['clerk1@example.com', 'clerk2@example.com', 'judge1@example.com'], 'not the user who switched alerts off, nor the admin without a court');
  const c1 = sent.find(m => m.to === 'clerk1@example.com');
  assert.match(c1.subject, /2 court date\(s\) on Friday, 23 October 2026/);
  assert.match(c1.text, /9:00 · GM\/45\/2026 · Musa Bello v\. Ali Sani · Hearing \(Mention\)/);
  assert.match(c1.text, /11:00 · GM\/46\/2026 · Ada Yusuf · Witness to attend/);
  assert.ok(c1.text.indexOf('GM/45/2026') < c1.text.indexOf('GM/46/2026'), 'in time order');
  assert.doesNotMatch(c1.text, /GM\/90\/2026|GM\/49\/2026/);
  assert.match(sent.find(m => m.to === 'clerk2@example.com').text, /Court sitting: cause list of 1 case/);

  assert.equal(await hearings.sendDigest(new Date(2026, 9, 22, 15)), null, 'once a day');
  assert.equal(mail.sent.length, start + 3);
});

test('Friday covers Monday; nothing at weekends or with alerts switched off', async () => {
  const start = mail.sent.length;
  const fri = await hearings.sendDigest(new Date(2026, 9, 23, 8));
  assert.equal(fri.day, '2026-10-26');
  assert.equal(fri.sent, 2, "the clerk and the judge of High Court 1");
  assert.equal(await hearings.sendDigest(new Date(2026, 9, 24, 8)), null);
  await settings.set({ emailAlerts: false });
  try { assert.equal(await hearings.sendDigest(new Date(2026, 9, 26, 8)), null); }
  finally { await settings.set({ emailAlerts: true }); }
  assert.equal(mail.sent.length, start + 2);
});

test('older records get their court dates at start up', async () => {
  const r = await Record.collection.insertOne({ unitKey: 'hc1', formType: 'hearing-notice', status: 'final', data: { suitNumber: 'GM/77/2025', hearingDate: inDays(1) },
    caseNos: ['GM/77/2025'], createdBy: new mongoose.Types.ObjectId(creator), createdAt: new Date() });
  await fillCaseNumbers(() => {});
  const doc = await Record.collection.findOne({ _id: r.insertedId });
  assert.equal(doc.events[0].date, inDays(1));
});

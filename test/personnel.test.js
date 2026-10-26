/*
 * The Nominal Roll of the Directorate of Personnel: who may see and change
 * it, the staff record (PSN unique), retirement at 60 years of age or 35
 * years of service (whichever comes first, or a contract's end), the record
 * of service, the documents folder (confidential documents), the photo,
 * the officers due to retire, the settings, and the import of a roll.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_personnel';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const { retirement } = require('../src/models');
const personnelImport = require('../src/services/personnelImport');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
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
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
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
const form = (fields, file, name = 'file.pdf') => { const f = new FormData(); Object.entries(fields).forEach(([k, v]) => f.append(k, v)); if (file) f.append('file', new Blob([file]), name); return f; };

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  u.secret = await makeUser({ fullName: 'Secret Registry Clerk', email: 'secret@example.com', privileges: ['personnel_edit'] });
  u.viewer = await makeUser({ fullName: 'Staff Officer', email: 'so@example.com', privileges: ['personnel_view'] });
  u.other = await makeUser({ fullName: 'Court Clerk', email: 'cc@example.com', unitKeys: ['hc3'], privileges: ['view', 'create', 'edit'] });
});
after(async () => { server.close(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('retirement: 60 years of age or 35 years of service, whichever comes first; a contract, its end', () => {
  assert.deepEqual(retirement({ dob: '1966-01-05', dofa: '2000-05-18' }), { date: '2026-01-05', by: 'age' });
  assert.deepEqual(retirement({ dob: '1970-03-01', dofa: '1991-11-07' }), { date: '2026-11-07', by: 'service' });
  assert.deepEqual(retirement({ dob: '1972-02-29', dofa: '' }), { date: '2032-02-29', by: 'age' });
  assert.deepEqual(retirement({ dob: '', dofa: '2000-02-29' }), { date: '2035-02-28', by: 'service' }, 'no 29 February: the 28th');
  assert.deepEqual(retirement({ dob: '1980-01-01', dofa: '2010-01-01', contract: true, contractEnds: '2027-06-30' }), { date: '2027-06-30', by: 'contract' });
});

test('who may see and change the roll; settings by the administrator', async () => {
  assert.equal((await u.other.get('/api/personnel/staff')).status, 403, 'not every user');
  assert.equal((await u.viewer.get('/api/personnel/staff')).status, 200, 'view only');
  assert.equal((await u.viewer.post('/api/personnel/staff', { psn: '1', name: 'X' })).status, 403, 'view only cannot add');
  const s = await u.secret.get('/api/personnel/settings');
  assert.ok(s.body.ranks.length > 50 && s.body.lgas.length === 11 && s.body.gls.includes('Cons.'));
  assert.equal((await u.secret.put('/api/personnel/settings', { stations: ['A'] })).status, 403);
  const put = await admin.put('/api/personnel/settings', { stations: ['High Court No. I', 'Chief Magistrate Court, Gombe', 'Directorate of Personnel'] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await admin.put('/api/personnel/settings', { stations: ['A', 'a'] })).status, 400, 'no station twice');
});

test('a staff record: PSN unique, rank tidied, retirement worked out, corrections and the record of service', async () => {
  const add = await u.secret.post('/api/personnel/staff', { psn: '24376', name: 'Musa Bello', sex: 'M', rank: 'S.C.O', gl: '7', dob: '1970-03-01', dofa: '1991-11-07', lga: 'Akko', station: 'High Court No. I' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const s = add.body.staff;
  assert.equal(s.rank, 'Senior Clerical Officer'); assert.equal(s.cadre, 'Clerical'); assert.equal(s.gl, '07');
  assert.equal(s.retiresOn, '2026-11-07'); assert.equal(s.retiresBy, 'service');
  assert.equal((await u.secret.post('/api/personnel/staff', { psn: '24376', name: 'Another' })).status, 409, 'PSN unique');
  assert.equal((await u.secret.post('/api/personnel/staff', { psn: '9', name: 'Bad', lga: 'Lagos' })).status, 400, 'a Gombe LGA');
  assert.equal((await u.secret.post('/api/personnel/staff', { psn: '10', name: 'CR', gl: 'Cons.', rank: 'Chief Registrar' })).body.staff.gl, 'Cons.');

  const fix = await u.secret.put(`/api/personnel/staff/${s.id}`, { dob: '1969-03-01', phone: '08030000000' });
  assert.equal(fix.body.staff.retiresOn, '2026-11-07');
  assert.match(fix.body.staff.history[0].text, /Date of birth: 1 March 1970 to 1 March 1969/);
  const promo = await u.secret.post(`/api/personnel/staff/${s.id}/events`, { kind: 'promotion', date: '2026-01-01', rank: 'C.C.O', gl: '08', step: 2 });
  assert.equal(promo.status, 200, JSON.stringify(promo.body));
  assert.equal(promo.body.staff.rank, 'Chief Clerical Officer'); assert.equal(promo.body.staff.gl, '08'); assert.equal(promo.body.staff.dopa, '2026-01-01');
  assert.match(promo.body.staff.history[0].text, /Promoted to Chief Clerical Officer, GL 08 step 2 \(from Senior Clerical Officer, GL 07\)/);
  const post = await u.secret.post(`/api/personnel/staff/${s.id}/events`, { kind: 'posting', date: '2026-02-01', station: 'Directorate of Personnel' });
  assert.match(post.body.staff.history[0].text, /Posted to Directorate of Personnel \(from High Court No. I\)/);
  assert.equal((await u.secret.post(`/api/personnel/staff/${s.id}/events`, { kind: 'status', date: '2026-03-01', status: 'nonsense' })).status, 400);
  await u.secret.post(`/api/personnel/staff/${s.id}/events`, { kind: 'confirmation', date: '1993-11-07' });
  assert.equal((await u.viewer.post(`/api/personnel/staff/${s.id}/events`, { kind: 'note', date: '2026-03-01', note: 'x' })).status, 403);

  const list = await u.viewer.get('/api/personnel/staff?station=Directorate%20of%20Personnel');
  assert.deepEqual(list.body.staff.map(x => x.psn), ['24376']);
  assert.equal((await u.viewer.get('/api/personnel/staff?q=bello')).body.staff.length, 1);
  const due = await u.viewer.get('/api/personnel/due-to-retire?months=12');
  assert.ok(due.body.staff.some(x => x.psn === '24376'), 'retires within 12 months');
  await u.secret.post(`/api/personnel/staff/${s.id}/events`, { kind: 'status', date: '2026-11-07', status: 'retired' });
  assert.ok(!(await u.viewer.get('/api/personnel/due-to-retire?months=12')).body.staff.some(x => x.psn === '24376'), 'not once retired');
  const opened = await u.viewer.get(`/api/personnel/staff/${s.id}`);
  assert.equal(opened.body.staff.canEdit, false);
  const log = await admin.get('/api/admin/audit?limit=200');
  assert.ok(JSON.stringify(log.body).includes('staff_record_opened'), 'opening a record is in the audit log');
});

test('documents folder (confidential ones only for editors) and the photo', async () => {
  const s = (await u.secret.post('/api/personnel/staff', { psn: '30001', name: 'Aisha Ahmed', sex: 'F', dob: '1980-05-05', dofa: '2005-05-05' })).body.staff;
  const open = await u.secret.upload(`/api/personnel/staff/${s.id}/documents`, form({ docType: 'Appointment letter', date: '2005-05-05' }, PDF));
  assert.equal(open.status, 201, JSON.stringify(open.body));
  const conf = await u.secret.upload(`/api/personnel/staff/${s.id}/documents`, form({ docType: 'Query and reply', confidential: '1' }, PDF));
  assert.equal(conf.body.document.confidential, true);
  assert.equal((await u.viewer.upload(`/api/personnel/staff/${s.id}/documents`, form({ docType: 'Certificate' }, PDF))).status, 403);
  const seen = (await u.viewer.get(`/api/personnel/staff/${s.id}/documents`)).body.documents;
  assert.equal(seen.length, 2);
  const c = seen.find(d => d.confidential);
  assert.equal(c.title, 'Confidential document'); assert.equal(c.url, null);
  assert.equal((await u.viewer.get(`/api/personnel/documents/${conf.body.document.id}/file`)).status, 403);
  assert.equal((await u.secret.get(`/api/personnel/documents/${conf.body.document.id}/file`)).status, 200);
  assert.equal((await u.viewer.get(`/api/personnel/documents/${open.body.document.id}/file`)).status, 200);
  assert.equal((await u.secret.upload(`/api/personnel/staff/${s.id}/photo`, form({}, PDF))).status, 400, 'a photo is a picture');
  const ph = await u.secret.upload(`/api/personnel/staff/${s.id}/photo`, form({}, PNG, 'me.png'));
  assert.equal(ph.body.staff.hasPhoto, true);
  assert.equal((await u.viewer.get(`/api/personnel/staff/${s.id}/photo`)).status, 200);
  assert.equal((await u.secret.del(`/api/personnel/staff/${s.id}`)).status, 403, 'only an administrator removes a record');
  assert.equal((await admin.del(`/api/personnel/staff/${s.id}`)).status, 200);
});

test('import: dates day first, Excel swaps settled from the sheet, ranks and LGAs tidied, checked first then saved', async () => {
  assert.equal(personnelImport.dateCell(46143).value, '2026-05-01');
  assert.equal(personnelImport.dateCell(46143).excel, true, 'an Excel date that may be swapped');
  assert.equal(personnelImport.dateCell('13/12/90').value, '1990-12-13');
  assert.equal(personnelImport.dateCell('1965').yearOnly, true);
  const csv = [
    'HIGH COURT OF JUSTICE STAFF NOMINAL ROLL',
    'S/NO,NAME,SEX,RANK,HIG. QUALIFICATION,GL,PSN,DOB,DOFA,LGA, CONTRACT,DOPA,EXP.DATE OF RET. BY AGE,EXP.DATE OF RET. BY SERVICE,STATION',
    '1,Bala Usman,M,Snr. Reg. I,Diploma in Law,12,40001,5/1/1966,18/5/2000,Y/Deba,,1/1/2020,5/1/2026,,High Court No. I',
    '2,Hauwa Ali,F,Watchman,SSCE,3,40002,4/4/1990,13/12/10,SHONGUM,,,,,Somewhere New',
    '3,Bad Dates,F,Mystery Rank,,5,40003,1975,1/1/2000,Gombe,Contract,,,,',
    '4,No Psn,M,Driver,,4,,1/1/1980,1/1/2005,Gombe,,,,,',
    '5,Twice,M,Driver,,4,40001,1/1/1980,1/1/2005,Gombe,,,,,',
    '6,Wrong Sheet,M,Driver,,4,40004,1/1/1980,1/1/2005,Kwami,,,1/1/2031,,',
    '7,Already,M,Driver,,4,24376,1/1/1980,1/1/2005,Kwami,,,,,'
  ].join('\n');
  const check = await u.secret.upload('/api/personnel/import', form({ commit: '0' }, Buffer.from(csv), 'roll.csv'));
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const row = (psn) => check.body.rows.find(x => x.psn === psn);
  assert.equal(check.body.toAdd, 4);
  assert.equal(check.body.skipped, 3);
  assert.equal(row('40001').rank, 'Senior Registrar I');
  assert.equal(row('40001').retiresOn, '2026-01-05');
  assert.equal(row('40001').check, false, 'agrees with the sheet');
  assert.ok(row('40002').notes.some(n => /Station "Somewhere New" is not in the list/.test(n)));
  assert.equal(row('40002').retiresOn, '2045-12-13', '35 years from 13 December 2010');
  assert.ok(row('40003').notes.some(n => /only the year/.test(n)) && row('40003').check);
  assert.ok(row('40003').notes.some(n => /Rank "Mystery Rank" is not in the list/.test(n)));
  assert.ok(row('40003').notes.some(n => /Contract officer with no contract end date/.test(n)));
  assert.ok(row('40004').notes.some(n => /does not agree/.test(n)) && row('40004').check, 'the sheet\'s retirement date disagrees');
  assert.ok(check.body.rows.some(x => !x.ok && x.problems.some(p => /No PSN/.test(p))));
  assert.ok(check.body.rows.some(x => !x.ok && x.problems.some(p => /given twice/.test(p))));
  assert.ok(row('24376').problems.some(p => /already on the roll/.test(p)));
  assert.equal((await u.viewer.upload('/api/personnel/import', form({ commit: '0' }, Buffer.from(csv), 'roll.csv'))).status, 403);
  const done = await u.secret.upload('/api/personnel/import', form({ commit: '1' }, Buffer.from(csv), 'roll.csv'));
  assert.equal(done.body.added, 4, JSON.stringify(done.body));
  const saved = (await u.viewer.get('/api/personnel/staff?q=Hauwa')).body.staff[0];
  assert.equal(saved.lga, 'Shongom'); assert.equal(saved.sex, 'F'); assert.equal(saved.gl, '03');
  assert.equal((await u.viewer.get('/api/personnel/staff?checkDates=1')).body.staff.length, 2);
  const yr = (await u.viewer.get('/api/personnel/staff?q=Bad%20Dates')).body.staff[0];
  assert.match((await u.viewer.get(`/api/personnel/staff/${yr.id}`)).body.staff.history[0].text, /Found on import: .*only the year/, 'why, in the record of service');
  assert.equal((await u.secret.post(`/api/personnel/staff/${yr.id}/dates-checked`)).body.staff.checkDates, false);
});

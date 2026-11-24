/*
 * The monthly cash flow: requests by the CJ's aide, the Chief Registrar and
 * the DCR Admin and Finance; the Hon. Chief Judge approves (in full or less,
 * with the PIN), declines or queries each item; the Accountant pays; the
 * balance carries from month to month; items left waiting move to the new
 * month; items not approved are carried or dismissed.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'Admin12345';
delete process.env.CLOUDINARY_URL;
delete process.env.BREVO_API_KEY;
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_cashflow';

const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const cf = require('../src/services/cashflow');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let server, base;
// A simple item: one line, quantity × unit price.
const one = (description, quantity, unitPrice) => [{ title: '', lines: [{ description, quantity, unitPrice }] }];
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
  async function upload(p, form) {
    const res = await fetch(base + p, { method: 'POST', headers: { 'X-Requested-With': 'GSHC', ...(cookie ? { Cookie: cookie } : {}) }, body: form });
    return { status: res.status, body: await res.json() };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b), upload };
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

before(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();
  await seedAll(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.post('/api/auth/login', { username: 'admin', password: 'Admin12345' });
  await admin.post('/api/auth/change-password', { currentPassword: 'Admin12345', newPassword: 'NewAdmin123' });
  u.cj = await makeUser({ fullName: 'Chief Judge', title: 'Hon. Justice', email: 'cj@example.com', signerRoles: ['chief_judge'] }, '1357');
  u.aide = await makeUser({ fullName: 'CJ Aide', email: 'aide@example.com', signerRoles: ['cj_aide'] });
  u.cr = await makeUser({ fullName: 'Chief Registrar', email: 'cr@example.com', signerRoles: ['chief_registrar'] });
  u.dcr = await makeUser({ fullName: 'DCR Admin', email: 'dcr@example.com', signerRoles: ['dcr_admin_finance'] });
  u.acct = await makeUser({ fullName: 'The Accountant', email: 'acct@example.com', signerRoles: ['accountant'] });
  u.clerk = await makeUser({ fullName: 'A Clerk', email: 'clerk@example.com', unitKeys: ['hc1'], privileges: ['view', 'create'] });
});
after(async () => { server.close(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('requests, the CJ\'s decisions item by item, payment, and the balance', async () => {
  const month = cf.thisMonth();
  assert.equal((await u.clerk.get('/api/cashflow')).status, 403, 'not for other staff');
  assert.equal((await u.acct.post('/api/cashflow', { item: 'Fuel', sections: one('Fuel', 1, 100) })).status, 403, 'the Accountant does not request');
  assert.equal((await u.cj.get('/api/admin/users')).status, 403);
  assert.equal((await admin.put('/api/cashflow/admin/releases', { month, amount: 1000000 })).status, 200, 'the administrator sets the release');
  assert.equal((await u.cr.put('/api/cashflow/admin/releases', { month, amount: 5 })).status, 403);

  // Three requests, one with an attachment.
  const form = new FormData();
  Object.entries({ item: 'Diesel for the generator', description: 'For the court complex', sections: JSON.stringify(one('Diesel, litres', 400, 1000)), department: 'Works', justification: 'Power outages' }).forEach(([k, v]) => form.append(k, v));
  form.append('files', new Blob(['%PDF-1.4']), 'quotation.pdf');
  let r = await u.aide.upload('/api/cashflow', form);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const fuel = r.body.item;
  assert.equal(fuel.amount, 400000, 'quantity times unit price');
  assert.equal(fuel.sn, 1);
  assert.equal(fuel.attachments.length, 1);
  const stat = (await u.cr.post('/api/cashflow', { item: 'Stationery', sections: one('Stationery', 1, 250000), justification: 'Registry stock' })).body.item;
  const trip = (await u.dcr.post('/api/cashflow', { item: 'Travel to Abuja', sections: one('Travel and lodging', 2, 150000) })).body.item;
  assert.ok((await u.cj.get('/api/notifications')).body.notifications.some(n => /put Stationery/.test(n.message)), 'the CJ is told');

  // The CJ sees the list, who submitted each, and the money; others do not see the money.
  let cj = (await u.cj.get('/api/cashflow')).body;
  assert.deepEqual(cj.items.map(x => [x.sn, x.item, x.requestedByRole]), [[1, 'Diesel for the generator', 'Aide to the Hon. Chief Judge'], [2, 'Stationery', 'Chief Registrar'], [3, 'Travel to Abuja', 'DCR Admin and Finance']]);
  assert.equal(cj.summary.released, 1000000);
  assert.equal(cj.summary.balance, 1000000);
  assert.equal((await u.cr.get('/api/cashflow')).body.summary, null, 'the money is for the CJ only');
  assert.equal((await u.cr.get('/api/cashflow')).body.items.length, 3, 'the Chief Registrar sees every item');
  assert.equal((await u.acct.get('/api/cashflow')).body.items.length, 0, 'the Accountant sees only the approved');

  // Approve less than asked, with the PIN.
  assert.equal((await u.cr.post(`/api/cashflow/${fuel.id}/decide`, { action: 'approve', pin: '1357' })).status, 403, 'only the CJ decides');
  assert.notEqual((await u.cj.post(`/api/cashflow/${fuel.id}/decide`, { action: 'approve', pin: '0000' })).status, 200, 'the PIN');
  assert.equal((await u.cj.post(`/api/cashflow/${fuel.id}/decide`, { action: 'approve', amount: 500000, pin: '1357' })).status, 400, 'not more than asked');
  r = await u.cj.post(`/api/cashflow/${fuel.id}/decide`, { action: 'approve', amount: 350000, pin: '1357' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.decision.amount, 350000);
  assert.ok(r.body.item.decision.signatureUrl);
  assert.ok((await u.acct.get('/api/notifications')).body.notifications.some(n => /Approved for payment: Diesel/.test(n.message)));
  // Return with a query; the requester answers and it comes back.
  assert.equal((await u.cj.post(`/api/cashflow/${stat.id}/decide`, { action: 'return' })).status, 400, 'the query is needed');
  await u.cj.post(`/api/cashflow/${stat.id}/decide`, { action: 'return', note: 'Attach the store request' });
  assert.equal((await u.dcr.put(`/api/cashflow/${stat.id}`, { answer: 'x' })).status, 409, 'only its requester');
  r = await u.cr.put(`/api/cashflow/${stat.id}`, { answer: 'Store request attached; reduced to 200,000', sections: one('Stationery', 1, 200000) });
  assert.equal(r.body.item.status, 'pending');
  assert.equal(r.body.item.amount, 200000);
  // Decline, leaving it to the requester.
  await u.cj.post(`/api/cashflow/${trip.id}/decide`, { action: 'decline', note: 'Not this month', requesterDecides: true });
  assert.equal((await u.cr.post(`/api/cashflow/${trip.id}/carry`)).status, 403, 'not someone else');

  // The Accountant pays the approved item; the balance goes down.
  assert.equal((await u.acct.post(`/api/cashflow/${fuel.id}/pay`, { pvNo: '' })).status, 400, 'the PV number');
  assert.equal((await u.acct.post(`/api/cashflow/${fuel.id}/pay`, { pvNo: 'PV/11/26', amount: 400000 })).status, 400, 'not more than approved');
  r = await u.acct.post(`/api/cashflow/${fuel.id}/pay`, { pvNo: 'PV/11/26' });
  assert.equal(r.body.item.status, 'paid');
  cj = (await u.cj.get('/api/cashflow')).body;
  assert.equal(cj.summary.paid, 350000);
  assert.equal(cj.summary.balance, 650000);
  assert.ok((await u.cj.get('/api/notifications')).body.notifications.some(n => /Paid: Diesel/.test(n.message)));

  // The requester carries the declined item to the next cash flow.
  r = await u.dcr.post(`/api/cashflow/${trip.id}/carry`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.month, cf.nextMonth(month));
  assert.equal(r.body.item.status, 'pending');
  assert.equal(r.body.item.carriedFrom, cf.monthName(month));
});

test('a new month: the balance is brought forward, and what was left waiting moves in', async () => {
  const { CashItem } = require('../src/models');
  const now = cf.thisMonth();
  // Make the stationery request (still pending) belong to last month.
  const [y, m] = now.split('-').map(Number);
  const last = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  await admin.put('/api/cashflow/admin/releases', { month: last, amount: 200000 });
  await CashItem.updateMany({ item: 'Stationery' }, { month: last });
  const r = (await u.cj.get(`/api/cashflow?month=${now}`)).body;
  const st = r.items.find(x => x.item === 'Stationery');
  assert.ok(st, 'moved into this month');
  assert.equal(st.carriedFrom, cf.monthName(last));
  assert.equal(r.summary.broughtForward, 200000, 'last month\'s balance comes forward');
  assert.equal(r.summary.available, 1200000);
  assert.equal(r.summary.balance, 850000);
  // The CJ dismisses an item not approved.
  await u.cj.post(`/api/cashflow/${st.id}/decide`, { action: 'decline', note: 'No' });
  assert.equal((await u.cr.post(`/api/cashflow/${st.id}/dismiss`)).status, 403, 'left to the CJ');
  assert.equal((await u.cj.post(`/api/cashflow/${st.id}/dismiss`)).body.item.status, 'dismissed');
  assert.ok(!(await u.cj.get(`/api/cashflow?month=${now}`)).body.items.some(x => x.item === 'Stationery'), 'off the list');
});

test('the administrator oversees the cash flow (everything, the money too) but does not act on it', async () => {
  const r = await admin.get('/api/cashflow');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 1, 'every item');
  assert.ok(r.body.summary && typeof r.body.balance === 'undefined' && r.body.summary.balance !== undefined, 'the money');
  const item = r.body.items[0];
  assert.equal((await admin.get(`/api/cashflow/${item.id}`)).status, 200, 'details');
  assert.equal((await admin.post('/api/cashflow', { item: 'X', sections: one('X', 1, 5) })).status, 403, 'no requests');
  const pending = r.body.items.find(x => x.status === 'pending');
  if (pending) assert.equal((await admin.post(`/api/cashflow/${pending.id}/decide`, { action: 'decline' })).status, 403, 'no decisions');
});

test('the printed approved cash flow has a QR code that confirms it, and shows if it was altered', async () => {
  const { CashSheet } = require('../src/models');
  const month = cf.thisMonth();
  const a = await u.cj.post('/api/cashflow/sheet', { month });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.verifyCode, /^GSHC-/);
  assert.match(a.body.qrDataUrl, /^data:image\/png/);
  assert.equal((await admin.post('/api/cashflow/sheet', { month })).body.verifyCode, a.body.verifyCode, 'printed again unchanged: the same code');
  assert.equal((await u.clerk.post('/api/cashflow/sheet', { month })).status, 403);
  const v = await fetch(`${base}/api/verify/${a.body.verifyCode}`).then(x => x.json());
  assert.equal(v.status, 'valid');
  assert.match(v.document, /Approved Cash Flow/);
  assert.match(v.reference, /total approved ₦350,000\.00/);
  assert.equal(v.signedBy[0].capacity, 'Hon. Chief Judge');
  // A new approval: the next print has a new code; the first still checks as it was.
  const n = (await u.aide.post('/api/cashflow', { item: 'Toner', sections: one('Toner', 3, 30000) })).body.item;
  await u.cj.post(`/api/cashflow/${n.id}/decide`, { action: 'approve', pin: '1357' });
  const b = await u.cj.post('/api/cashflow/sheet', { month });
  assert.notEqual(b.body.verifyCode, a.body.verifyCode);
  assert.equal((await fetch(`${base}/api/verify/${a.body.verifyCode}`).then(x => x.json())).status, 'valid');
  // Altered in the database: the check says so.
  await CashSheet.updateOne({ verifyCode: a.body.verifyCode }, { total: 1 });
  assert.equal((await fetch(`${base}/api/verify/${a.body.verifyCode}`).then(x => x.json())).status, 'tampered');
});

test('an item in sections, each with lines and a subtotal; the CJ approves part of it', async () => {
  const reno = [
    { title: 'Roofing', lines: [{ description: 'Roofing sheets', quantity: 120, unitPrice: 8500 }, { description: 'Nails', quantity: 10, unitPrice: 3000 }, { description: 'Labour', quantity: 1, unitPrice: 250000 }] },
    { title: 'Painting', lines: [{ description: 'Paint, buckets', quantity: 40, unitPrice: 12000 }, { description: 'Labour', quantity: 1, unitPrice: 150000 }] }
  ];
  // Quantity and unit price on every line; headings when there are sections.
  assert.equal((await u.cr.post('/api/cashflow', { item: 'Renovation', sections: [{ title: '', lines: [{ description: 'Sheets', quantity: 2 }] }] })).status, 400, 'the unit price');
  assert.equal((await u.cr.post('/api/cashflow', { item: 'Renovation', sections: [{ title: '', lines: [{ description: 'Sheets', unitPrice: 5 }] }] })).status, 400, 'the quantity');
  assert.equal((await u.cr.post('/api/cashflow', { item: 'Renovation', sections: [reno[0], { ...reno[1], title: '' }] })).status, 400, 'each section a heading');
  assert.equal((await u.cr.post('/api/cashflow', { item: 'Renovation' })).status, 400, 'at least one line');
  let r = await u.cr.post('/api/cashflow', { item: 'Renovation of High Court No. II', sections: reno, amount: 5 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const it = r.body.item;
  assert.equal(it.amount, 1930000, 'the grand total, worked out (not the amount sent)');
  assert.deepEqual(it.sections.map(sec => [sec.title, sec.subtotal]), [['Roofing', 1300000], ['Painting', 630000]]);
  assert.equal(it.sections[0].lines[0].amount, 1020000);
  // Approve the roofing and the paint, not the painting labour.
  assert.equal((await u.cj.post(`/api/cashflow/${it.id}/decide`, { action: 'approve', pin: '1357', struck: ['0.0', '0.1', '0.2', '1.0', '1.1'] })).status, 400, 'not every line struck');
  assert.equal((await u.cj.post(`/api/cashflow/${it.id}/decide`, { action: 'approve', pin: '1357', struck: ['1.1'], amount: 1800000 })).status, 400, 'not more than the lines approved');
  r = await u.cj.post(`/api/cashflow/${it.id}/decide`, { action: 'approve', pin: '1357', struck: ['1.1'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.decision.amount, 1780000);
  assert.equal(r.body.item.sections[1].lines[1].struck, true);
  assert.equal(r.body.item.sections[1].approvedSubtotal, 480000);
  assert.match(r.body.item.history[0].note, /Not approved: Labour/);
});

test('items made before sections become one line each', async () => {
  const { CashItem } = require('../src/models');
  const doc = await CashItem.collection.insertOne({ month: cf.thisMonth(), sn: 99, item: 'Old item', amount: 75000, quantity: null, unitPrice: null, status: 'pending',
    requestedBy: new mongoose.Types.ObjectId(u.aide.id), requestedByName: 'CJ Aide', history: [], attachments: [] });
  const r = await u.cj.get(`/api/cashflow/${doc.insertedId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.item.sections[0].lines.map(l => [l.description, l.quantity, l.unitPrice, l.amount]), [['Old item', 1, 75000, 75000]]);
  const a = await u.cj.post(`/api/cashflow/${doc.insertedId}/decide`, { action: 'approve', pin: '1357' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.item.decision.amount, 75000);
});

test('a role held only for the cash flow opens no unit', async () => {
  const units = async (c) => (await c.get('/api/catalogue/units')).body.units.map(x => x.key);
  assert.deepEqual(await units(u.aide), [], 'the CJ\'s aide: no unit');
  assert.deepEqual(await units(u.acct), [], 'the Accountant: no unit');
  assert.deepEqual(await units(u.dcr), [], 'the DCR Admin and Finance: no unit');
  assert.ok((await units(u.cr)).includes('hc1'), 'the Chief Registrar still reaches the courts');
  const given = await makeUser({ fullName: 'Aide With Unit', email: 'aide2@example.com', signerRoles: ['cj_aide'], unitKeys: ['hc1'] });
  assert.deepEqual(await units(given), ['hc1'], 'a unit given to them in Settings');
});

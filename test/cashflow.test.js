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
  assert.equal((await u.dcr.put('/api/cashflow/admin/releases', { month, amount: 5 })).status, 403, 'not the DCR');
  assert.equal((await u.cr.put('/api/cashflow/admin/releases', { month, amount: 1000000 })).status, 200, 'the Chief Registrar enters the overhead received');
  assert.ok((await u.cj.get('/api/notifications')).body.notifications.some(n => /overhead received/.test(n.message)), 'the CJ is told');

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
  assert.equal((await u.dcr.get('/api/cashflow')).body.summary, null, 'not the money');
  assert.equal((await u.cr.get('/api/cashflow')).body.summary.released, 1000000, 'the Chief Registrar sees the money');
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
  assert.ok((await u.dcr.get('/api/notifications')).body.notifications.some(n => /for release of funds: Diesel/.test(n.message)), 'the DCR is told');
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

  // The DCR requests the release of funds; the CJ approves it; the Accountant pays; the balance goes down.
  const payee = { name: 'Gombe Fuels Ltd', bank: 'Zenith Bank', accountNo: '1012345678', amount: 350000 };
  r = await u.dcr.post('/api/cashflow/releases', { items: [{ item: fuel.id, payees: [payee] }], note: 'For the November diesel' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rel = r.body.release;
  assert.match(rel.refNo, /^GSHC\/CF\/REL\/\d{4}\/0001$/);
  assert.equal((await u.acct.post(`/api/cashflow/releases/${rel.id}/pay`, { payee: rel.items[0].payees[0].id, pvNo: 'PV/11/26' })).status, 403, 'not before the CJ approves the release');
  r = await u.cj.post(`/api/cashflow/releases/${rel.id}/decide`, { action: 'approve', pin: '1357' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pid = rel.items[0].payees[0].id;
  // The Chief Registrar transmits it to the Accountant; not before.
  assert.ok((await u.cr.get('/api/notifications')).body.notifications.some(n => /Transmit it to the Accountant/.test(n.message)), 'the CR is told');
  assert.equal((await u.acct.get('/api/cashflow/releases')).body.releases.length, 0, 'the Accountant does not see it yet');
  assert.equal((await u.acct.post(`/api/cashflow/releases/${rel.id}/pay`, { payee: pid, pvNo: 'PV/11/26' })).status, 403, 'not before transmission');
  assert.equal((await u.dcr.post('/api/cashflow/releases/transmit', { ids: [rel.id] })).status, 403, 'only the CR transmits');
  r = await u.cr.post('/api/cashflow/releases/transmit', { ids: [rel.id], note: 'Please pay' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await u.cr.post('/api/cashflow/releases/transmit', { ids: [rel.id] })).status, 409, 'not twice');
  assert.ok((await u.acct.get('/api/notifications')).body.notifications.some(n => /transmitted by the Chief Registrar/.test(n.message)), 'the Accountant is told');
  assert.equal((await u.acct.post(`/api/cashflow/releases/${rel.id}/pay`, { payee: pid, pvNo: '' })).status, 400, 'the PV number');
  // The amount is locked to what the CJ approved, whatever is sent.
  r = await u.acct.post(`/api/cashflow/releases/${rel.id}/pay`, { payee: pid, pvNo: 'PV/11/26', amount: 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.release.items[0].payees[0].paid.amount, 350000);
  assert.equal(r.body.release.status, 'paid');
  assert.equal((await u.cj.get(`/api/cashflow/${fuel.id}`)).body.item.status, 'paid');
  cj = (await u.cj.get('/api/cashflow')).body;
  assert.equal(cj.summary.paid, 350000);
  assert.equal(cj.summary.balance, 650000);
  assert.ok((await u.cj.get('/api/notifications')).body.notifications.some(n => /Paid: .* to Gombe Fuels Ltd for Diesel/.test(n.message)));

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

let renoId;
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
  renoId = it.id;
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

test('release of funds: several beneficiaries, instalments, queries, a decline frees the amount', async () => {
  // The renovation: ₦1,780,000 approved. A first instalment to two contractors.
  const roofer = { name: 'Bauchi Roofing Works', bank: 'First Bank of Nigeria', accountNo: '3012345678', amount: 700000 };
  const painter = { name: 'Yalwa Painters', bank: 'Jaiz Bank', accountNo: '0012345678', amount: 200000 };
  assert.equal((await u.cr.post('/api/cashflow/releases', { items: [{ item: renoId, payees: [roofer] }] })).status, 403, 'only the DCR');
  assert.equal((await u.dcr.post('/api/cashflow/releases', { items: [{ item: renoId, payees: [{ ...roofer, accountNo: '12345' }] }] })).status, 400, 'ten digits');
  assert.equal((await u.dcr.post('/api/cashflow/releases', { items: [{ item: renoId, payees: [{ ...roofer, amount: 2000000 }] }] })).status, 400, 'not more than approved');
  let r = await u.dcr.post('/api/cashflow/releases', { items: [{ item: renoId, payees: [roofer, painter] }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const first = r.body.release;
  assert.equal(first.total, 900000);
  let item = (await u.dcr.get(`/api/cashflow/${renoId}`)).body.item;
  assert.equal(item.released, 900000);
  assert.equal(item.toRelease, 880000);
  assert.equal((await u.dcr.post('/api/cashflow/releases', { items: [{ item: renoId, payees: [{ ...roofer, amount: 900000 }] }] })).status, 400, 'not more than is left');
  // A second instalment; the CJ returns it with a query, the DCR corrects it.
  r = await u.dcr.post('/api/cashflow/releases', { items: [{ item: renoId, payees: [{ ...roofer, amount: 500000 }] }] });
  const second = r.body.release;
  await u.cj.post(`/api/cashflow/releases/${second.id}/decide`, { action: 'return', note: 'Roof first; send this after inspection' });
  assert.equal((await u.dcr.put(`/api/cashflow/releases/${second.id}`, { items: [{ item: renoId, payees: [{ ...roofer, amount: 880000 }] }] })).status, 400, 'the answer');
  r = await u.dcr.put(`/api/cashflow/releases/${second.id}`, { answer: 'Inspected; full balance', items: [{ item: renoId, payees: [{ ...roofer, amount: 880000 }] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.release.status, 'pending');
  // The CJ approves both at once, with one PIN.
  assert.notEqual((await u.cj.post('/api/cashflow/releases/decide-many', { ids: [first.id, second.id], pin: '0000' })).status, 200, 'the PIN');
  r = await u.cj.post('/api/cashflow/releases/decide-many', { ids: [first.id, second.id], pin: '1357' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.approved, 2);
  r = await u.cr.post('/api/cashflow/releases/transmit', { ids: [first.id, second.id] });
  assert.equal(r.body.transmitted, 2, 'the CR transmits both at once');
  // The Accountant pays each beneficiary; the item is paid when all is paid.
  const pay = async (rel, i, pv) => u.acct.post(`/api/cashflow/releases/${rel.id}/pay`, { payee: rel.items[0].payees[i].id, pvNo: pv });
  assert.equal((await pay(first, 0, 'PV/1')).status, 200);
  assert.equal((await pay(first, 0, 'PV/1')).status, 409, 'not twice');
  assert.equal((await pay(first, 1, 'PV/2')).status, 200);
  item = (await u.cj.get(`/api/cashflow/${renoId}`)).body.item;
  assert.equal(item.status, 'approved', 'part paid');
  assert.equal(item.paid, 900000);
  assert.equal(item.releases.length, 2);
  const s2 = (await u.cj.get(`/api/cashflow/releases/${second.id}`)).body.release;
  assert.equal((await pay(s2, 0, 'PV/3')).status, 200);
  item = (await u.cj.get(`/api/cashflow/${renoId}`)).body.item;
  assert.equal(item.status, 'paid');
  assert.equal(item.payments.length, 3);
  // A declined release frees its amount; a part paid item can be closed.
  const toner = (await u.cj.get('/api/cashflow')).body.items.find(x => x.item === 'Toner');
  r = await u.dcr.post('/api/cashflow/releases', { items: [{ item: toner.id, payees: [{ name: 'Office Supplies', bank: 'Access Bank', accountNo: '0712345678', amount: 90000 }] }] });
  await u.cj.post(`/api/cashflow/releases/${r.body.release.id}/decide`, { action: 'decline', note: 'Use the store stock' });
  assert.equal((await u.dcr.get(`/api/cashflow/${toner.id}`)).body.item.toRelease, 90000, 'free again');
  r = await u.dcr.post('/api/cashflow/releases', { items: [{ item: toner.id, payees: [{ name: 'Office Supplies', bank: 'Access Bank', accountNo: '0712345678', amount: 60000 }] }] });
  await u.cj.post(`/api/cashflow/releases/${r.body.release.id}/decide`, { action: 'approve', pin: '1357' });
  await u.cr.post('/api/cashflow/releases/transmit', { ids: [r.body.release.id] });
  await u.acct.post(`/api/cashflow/releases/${r.body.release.id}/pay`, { payee: r.body.release.items[0].payees[0].id, pvNo: 'PV/4' });
  assert.equal((await u.cr.post(`/api/cashflow/${toner.id}/complete`)).status, 403);
  r = await u.dcr.post(`/api/cashflow/${toner.id}/complete`, { note: 'The rest from store' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.status, 'paid');
});

test('the CJ approves several cash flow items at once, with one PIN', async () => {
  const a = (await u.aide.post('/api/cashflow', { item: 'Water', sections: one('Water, cartons', 50, 2000) })).body.item;
  const b = (await u.cr.post('/api/cashflow', { item: 'Cleaning', sections: one('Detergent', 20, 1500) })).body.item;
  assert.equal((await u.cr.post('/api/cashflow/decide-many', { ids: [a.id, b.id], pin: '1357' })).status, 403);
  assert.notEqual((await u.cj.post('/api/cashflow/decide-many', { ids: [a.id, b.id], pin: '0000' })).status, 200, 'the PIN');
  const r = await u.cj.post('/api/cashflow/decide-many', { ids: [a.id, b.id], pin: '1357', note: 'Approved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 130000);
  assert.equal((await u.cj.get(`/api/cashflow/${a.id}`)).body.item.decision.amount, 100000);
  assert.equal((await u.cj.post('/api/cashflow/decide-many', { ids: [a.id], pin: '1357' })).status, 409, 'already decided');
});

test('the approved release memo has a QR code that confirms the beneficiaries and amounts', async () => {
  const { CashRelease } = require('../src/models');
  const list = (await u.cj.get('/api/cashflow/releases')).body.releases;
  const ok = list.find(x => x.status !== 'declined' && x.items.some(i => i.name === 'Diesel for the generator'));
  const q = await u.dcr.get(`/api/cashflow/releases/${ok.id}/qr`);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.match(q.body.qrDataUrl, /^data:image\/png/);
  let v = await fetch(`${base}/api/verify/${q.body.verifyCode}`).then(x => x.json());
  assert.equal(v.status, 'valid');
  assert.match(v.document, /Release of Funds: GSHC\/CF\/REL/);
  assert.deepEqual(v.lines, ['Gombe Fuels Ltd · Zenith Bank · ******5678 · ₦350,000.00'], 'the account number masked');
  // Not before approval.
  const waiting = (await u.dcr.post('/api/cashflow/releases', { items: [{ item: (await u.cj.get('/api/cashflow')).body.items.find(x => x.item === 'Cleaning').id, payees: [{ name: 'Clean Co', bank: 'Wema Bank', accountNo: '0123456789', amount: 30000 }] }] })).body.release;
  assert.equal((await u.dcr.get(`/api/cashflow/releases/${waiting.id}/qr`)).status, 404);
  // An account number changed in the database: the check says so, and the Accountant cannot pay it.
  const doc = await CashRelease.findById(ok.id);
  doc.items[0].payees[0].accountNo = '9999999999';
  doc.markModified('items');
  await doc.save();
  v = await fetch(`${base}/api/verify/${q.body.verifyCode}`).then(x => x.json());
  assert.equal(v.status, 'tampered');
  await u.cj.post(`/api/cashflow/releases/${waiting.id}/decide`, { action: 'approve', pin: '1357' });
  await u.cr.post('/api/cashflow/releases/transmit', { ids: [waiting.id] });
  const w = (await u.acct.get(`/api/cashflow/releases/${waiting.id}`)).body.release;
  await CashRelease.updateOne({ _id: waiting.id }, { $set: { 'items.0.payees.0.amount': 90000 } });
  assert.equal((await u.acct.post(`/api/cashflow/releases/${waiting.id}/pay`, { payee: w.items[0].payees[0].id, pvNo: 'PV/9' })).status, 409, 'altered after approval: not paid');
});

test('the monthly mandatories: Chief Accountant, Chief Registrar, Hon. Chief Judge, transmission, payment, and the money', async () => {
  const month = cf.thisMonth();
  const casual = { title: 'Casual staff', payees: [{ name: 'Musa Ali', bank: 'Jaiz Bank', accountNo: '0011223344', amount: 30000 }, { name: 'Aisha Bello', bank: 'Zenith Bank', accountNo: '2011223344', amount: 30000 }] };
  const starlink = { title: 'Starlink subscription', payees: [{ name: 'Starlink Internet Services Nigeria', bank: 'Access Bank', accountNo: '0711223344', amount: 38000 }] };
  const allowance = { title: 'Allowance to heads of units', payees: [{ name: 'Hauwa Musa', bank: 'First Bank of Nigeria', accountNo: '3011223344', amount: 50000 }] };
  assert.equal((await u.cr.post('/api/cashflow/mandatories', { month, items: [casual] })).status, 403, 'the Chief Accountant prepares');
  assert.equal((await u.acct.post('/api/cashflow/mandatories', { month, items: [{ title: 'X', payees: [{ name: 'Y', bank: 'Z', accountNo: '1', amount: 5 }] }] })).status, 400, 'ten digits');
  let r = await u.acct.post('/api/cashflow/mandatories', { month, items: [casual, starlink, allowance] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let m = r.body.list;
  assert.equal(m.total, 148000);
  assert.equal(m.status, 'with_cr');
  assert.match(m.refNo, /^GSHC\/CF\/MAN\/\d{4}\/0001$/);
  // The CJ cannot approve before the Chief Registrar sends it; the CR returns it with a query.
  assert.equal((await u.cj.post(`/api/cashflow/mandatories/${m.id}/approve`, { pin: '1357' })).status, 409);
  r = await u.cr.post(`/api/cashflow/mandatories/${m.id}/return`, { note: 'Attach the casual staff attendance' });
  assert.equal(r.body.list.status, 'returned');
  assert.equal((await u.acct.put(`/api/cashflow/mandatories/${m.id}`, { items: [casual, starlink, allowance] })).status, 400, 'the answer');
  r = await u.acct.put(`/api/cashflow/mandatories/${m.id}`, { answer: 'Attendance attached', items: [casual, starlink, allowance] });
  assert.equal(r.body.list.status, 'with_cr');
  // The CR sends it on; the CJ approves it without the allowance.
  assert.equal((await u.dcr.post(`/api/cashflow/mandatories/${m.id}/forward`)).status, 403);
  r = await u.cr.post(`/api/cashflow/mandatories/${m.id}/forward`, { note: 'Recommended' });
  assert.equal(r.body.list.status, 'pending');
  assert.ok((await u.cj.get('/api/notifications')).body.notifications.some(n => /mandatories/.test(n.message)), 'the CJ is told');
  assert.notEqual((await u.cj.post(`/api/cashflow/mandatories/${m.id}/approve`, { pin: '0000' })).status, 200, 'the PIN');
  r = await u.cj.post(`/api/cashflow/mandatories/${m.id}/approve`, { pin: '1357', struck: [2] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  m = r.body.list;
  assert.equal(m.approvedTotal, 98000);
  // The money: the mandatories come out of what is available, before the cash flow.
  const s = (await u.cj.get(`/api/cashflow?month=${month}`)).body.summary;
  assert.equal(s.mandatories, 98000);
  assert.equal(s.forCashflow, Math.round((s.available - 98000) * 100) / 100);
  // Not paid before the CR transmits; then the amount is what was approved.
  const pay = (i, j) => u.acct.post(`/api/cashflow/mandatories/${m.id}/pay`, { payee: m.items[i].payees[j].id, pvNo: `PV/M/${i}${j}`, amount: 1 });
  assert.equal((await pay(0, 0)).status, 409, 'not before transmission');
  r = await u.cr.post(`/api/cashflow/mandatories/${m.id}/transmit`, { note: 'Pay by the 25th' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await pay(2, 0)).status, 409, 'not a mandatory the CJ left out');
  r = await pay(0, 0);
  assert.equal(r.body.list.items[0].payees[0].paid.amount, 30000);
  await pay(0, 1);
  r = await pay(1, 0);
  assert.equal(r.body.list.status, 'paid');
  const after = (await u.cj.get(`/api/cashflow?month=${month}`)).body.summary;
  assert.equal(after.mandatoriesPaid, 98000);
  assert.equal(after.balance, Math.round((after.available - after.paid) * 100) / 100);
  // The QR check, and next month's list starts from this one.
  const q = await u.cj.get(`/api/cashflow/mandatories/${m.id}/qr`);
  const v = await fetch(`${base}/api/verify/${q.body.verifyCode}`).then(x => x.json());
  assert.equal(v.status, 'valid');
  assert.match(v.document, /Monthly Mandatories/);
  assert.equal(v.lines.length, 2);
  const t = (await u.acct.get('/api/cashflow/mandatories/template')).body;
  assert.deepEqual(t.items.map(x => x.title), ['Casual staff', 'Starlink subscription'], 'what was approved last month');
});

test('mandatories: beneficiaries imported from a spreadsheet (Excel or CSV)', async () => {
  const { xlsx } = require('./helpers/xlsx');
  const send = (c, buf, name) => { const f = new FormData(); f.append('file', new Blob([buf]), name); return c.upload('/api/cashflow/mandatories/import', f); };
  // Excel: headings on the second row, columns in any order, numbers for account numbers (the leading zero lost).
  const book = xlsx([
    ['Mandatories for December'],
    ['S/N', 'Amount', 'Name', 'Bank', 'Account No', 'Mandatory'],
    [1, 30000, 'Musa Ali', 'Jaiz Bank', 11223344, 'Casual staff'],
    [2, 30000, 'Aisha Bello', 'Zenith Bank', 2011223344, 'Casual staff'],
    [3, 38000, 'Starlink Internet Services Nigeria', 'Access Bank', 711223344, 'Starlink subscription'],
    [4, '', 'No Amount', 'Wema Bank', 1234567890, 'Casual staff'],
    [5, 5000, 'Bad Account', 'Wema Bank', 12345, 'Casual staff']
  ]);
  assert.equal((await send(u.cr, book, 'm.xlsx')).status, 403, 'the Chief Accountant only');
  let r = await send(u.acct, book, 'December.xlsx');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hasMandatory, true);
  assert.deepEqual(r.body.payees.map(p => [p.mandatory, p.name, p.accountNo, p.amount]), [
    ['Casual staff', 'Musa Ali', '0011223344', 30000], ['Casual staff', 'Aisha Bello', '2011223344', 30000],
    ['Starlink subscription', 'Starlink Internet Services Nigeria', '0711223344', 38000]]);
  assert.deepEqual(r.body.problems.map(p => [p.row, p.reason.split(' ')[0]]), [[6, 'no'], [7, 'account']], 'rows left out, with the reason');
  assert.deepEqual(r.body.notes.map(n => n.row), [3, 5], 'leading zeros put back');
  // CSV, without a Mandatory column, amounts with commas and the naira sign.
  const csv = 'Beneficiary,Bank,Account Number,Account Name,Amount\r\nHauwa Musa,First Bank of Nigeria,3011223344,Hauwa M. Musa,"₦50,000.00"\r\n';
  r = await send(u.acct, Buffer.from(csv), 'allowance.csv');
  assert.equal(r.body.hasMandatory, false);
  assert.deepEqual(r.body.payees.map(p => [p.name, p.accountName, p.amount]), [['Hauwa Musa', 'Hauwa M. Musa', 50000]]);
  // No headings: a clear message.
  r = await send(u.acct, Buffer.from('a,b\r\n1,2\r\n'), 'x.csv');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /headings were not found/);
  const t = await u.acct.get('/api/cashflow/mandatories/import-template');
  assert.equal(t.status, 200);
  assert.match(t.body.toString(), /Mandatory,Beneficiary,Bank,Account Number,Account Name,Amount/);
});

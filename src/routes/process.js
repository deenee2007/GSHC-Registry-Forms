/*
 * src/routes/process.js — the Process Registry.
 *
 *   draft ──submit──▶ submitted ──register (number given)──▶ awaiting_assignment
 *     ▲                   │                                       │ Chief Judge assigns
 *     └──── returned ◀────┘                                       ▼
 *               assigned ──dispatch (file sent)──▶ dispatched ──file received──▶ received ──remark──▶ disposed
 *
 * Process Registry staff file new cases and print the invoice the filer
 * takes to pay; then the receipt number and (unless the administrator made
 * it optional) an upload of the receipt. Official cases bear no fee. The Process Registrar
 * registers each one, which gives the next suit number of its type and
 * proposes the next court in turn. The Hon. Chief Judge assigns it with
 * their PIN; the signed assignment prints as a small slip with a QR code,
 * and the case appears in that court's Case Register. The court can mark
 * the file received only after the Process Registry dispatches it.
 */
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { Case, Unit, User, Notification } = require('../models');
const processSvc = require('../services/process');
const fileStore = require('../services/fileStore');
const store = require('../services/signatureStore');
const verification = require('../services/verification');
const catalogue = require('../forms/catalogue');
const audit = require('../services/audit');
const mail = require('../services/mail');
const settings = require('../services/settings');
const caseEmail = require('../services/caseEmail');
const { verifyPin } = require('./me');
const { HttpError, requireLogin, canAccessUnit, can, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: fileStore.MAX_BYTES, files: 1 } });

// ── Who may do what ──
// The Process Registrar works in the Process Registry even without the unit.
const inProcess = (u) => isAdmin(u) || u.unitKeys.includes('process') || u.signerRoles.includes('process_registrar');
const isRegistrar = (u) => isAdmin(u) || u.signerRoles.includes('process_registrar');
const isCJ = (u) => u.signerRoles.includes('chief_judge');
const inCourt = (u, key) => !!key && canAccessUnit(u, key) && (can(u, 'view') || u.signerRoles.length > 0);
const canSee = (u, c) => inProcess(u) || isCJ(u) || inCourt(u, c.assignedUnit);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const oid = (id) => { if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Case not found.'); return id; };

async function load(id, user) {
  const c = await Case.findById(oid(id));
  if (!c) throw new HttpError(404, 'Case not found.');
  if (!canSee(user, c)) throw new HttpError(403, 'You do not have access to this case.');
  return c;
}

async function unitNames() {
  return Object.fromEntries((await Unit.find({}, 'key name courtNo').lean()).map(u => [u.key, u]));
}

function serialize(c, units, extra = {}) {
  const o = c.toObject ? c.toObject() : c;
  const court = (k) => (k && units[k] ? { key: k, name: units[k].name, courtNo: units[k].courtNo, roman: processSvc.roman(units[k].courtNo) } : null);
  return {
    id: String(o._id), caseType: o.caseType, suitNumber: o.suitNumber || '', earlier: !!o.earlier,
    firstParty: o.firstParty, secondParty: o.secondParty, nature: o.nature, process: o.process,
    counsel: o.counsel, counselAddress: o.counselAddress, filedOn: o.filedOn, efcc: o.efcc, official: o.official,
    fees: o.fees || [], feeTotal: o.feeTotal || 0, receiptNumber: o.receiptNumber,
    invoice: o.invoice && o.invoice.reference ? { reference: o.invoice.reference, issuedAt: o.invoice.issuedAt, issuedByName: o.invoice.issuedByName, fees: o.invoice.fees || [], total: o.invoice.total || 0 } : null,
    receipt: o.receipt ? { name: o.receipt.name, contentType: o.receipt.contentType, bytes: o.receipt.bytes, uploadedAt: o.receipt.uploadedAt } : null,
    status: o.status, returnComment: o.returnComment, returnedByName: o.returnedByName,
    createdBy: o.createdBy ? String(o.createdBy) : null, createdByName: o.createdByName, createdAt: o.createdAt,
    registeredByName: o.registeredByName, registeredAt: o.registeredAt,
    proposed: court(o.proposedUnit), assigned: court(o.assignedUnit), assignedAt: o.assignedAt,
    assignment: o.assignment ? { name: o.assignment.name, title: o.assignment.title, signedAt: o.assignment.signedAt } : null,
    verifyCode: o.verifyCode, verifyUrl: o.verifyUrl,
    emails: { firstParty: (o.emails && o.emails.firstParty) || [], secondParty: (o.emails && o.emails.secondParty) || [], counsel: (o.emails && o.emails.counsel) || [] },
    emailLog: (o.emailLog || []).map(e => ({ stage: e.stage, label: caseEmail.LABELS[e.stage] || e.stage, to: e.to, at: e.at, ok: e.ok })),
    dispatchedAt: o.dispatchedAt, dispatchedByName: o.dispatchedByName,
    receivedAt: o.receivedAt, receivedByName: o.receivedByName, disposal: o.disposal || null,
    ...extra
  };
}

// In app notices, and an email where the person allows alerts.
async function tell(users, message, link, subject) {
  const list = users.filter(Boolean);
  if (!list.length) return;
  await Notification.insertMany(list.map(u => ({ user: u._id, kind: 'case', link, message })));
  try {
    if (!mail.enabled() || !(await settings.get()).emailAlerts) return;
    await Promise.allSettled(list.filter(u => u.email && u.emailAlerts !== false && !u.emailAlertsBlocked)
      .map(u => mail.send({ to: u.email, name: u.fullName, ...mail.alertMessage(u, subject, message, '') })));
  } catch (e) { console.error('Case alert emails failed:', e.message); }
}
const processPeople = (filter = {}) => User.find({ active: true, $or: [{ unitKeys: 'process' }, { signerRoles: 'process_registrar' }], ...filter });

// Check and tidy what the filer typed; the fee total is worked out here.
async function cleanCase(body) {
  const s = await processSvc.getSettings();
  const out = {};
  const str = (k, max = 300) => { if (body[k] !== undefined) out[k] = String(body[k] || '').trim().slice(0, max); };
  if (body.caseType !== undefined) {
    if (!s.caseTypes.some(t => t.key === body.caseType)) throw new HttpError(400, 'Choose the case type.');
    out.caseType = body.caseType;
  }
  ['firstParty', 'secondParty'].forEach(k => str(k, 1000));
  ['nature', 'process', 'counsel', 'receiptNumber'].forEach(k => str(k, 300));
  str('counselAddress', 1000);
  if (body.filedOn !== undefined) {
    if (body.filedOn && !DAY.test(body.filedOn)) throw new HttpError(400, 'Enter the date of filing.');
    out.filedOn = body.filedOn || today();
  }
  if (body.efcc !== undefined) out.efcc = !!body.efcc;
  if (body.official !== undefined) out.official = !!body.official;
  if (out.efcc) out.official = true; // EFCC matters bear no filing fee
  if (body.fees !== undefined) {
    if (!Array.isArray(body.fees)) throw new HttpError(400, 'Invalid fees.');
    out.fees = body.fees.slice(0, 50).map(f => {
      const qty = Math.max(1, Math.min(1000, parseInt(f.qty, 10) || 1));
      const listed = s.fees.find(x => x.item === f.item);
      const amount = listed ? listed.amount : Number(f.amount);
      if (!String(f.item || '').trim()) throw new HttpError(400, 'Every fee line needs a description.');
      if (!(amount >= 0)) throw new HttpError(400, `Enter the amount for ${f.item}.`);
      return { item: String(f.item).trim().slice(0, 120), amount, qty };
    });
    out.feeTotal = Math.round(out.fees.reduce((n, f) => n + f.amount * f.qty, 0) * 100) / 100;
  }
  if (out.official) { out.fees = []; out.feeTotal = 0; }
  if (body.emails !== undefined) {
    const e = body.emails || {};
    try {
      out.emails = { firstParty: caseEmail.cleanEmails(e.firstParty, 'first party'), secondParty: caseEmail.cleanEmails(e.secondParty, 'second party'), counsel: caseEmail.cleanEmails(e.counsel, 'counsel') };
    } catch (err) { throw new HttpError(400, err.message); }
  }
  return out;
}

// ── Settings (read by everyone who works with cases; changed by admins) ──
router.get('/settings', wrap(async (req, res) => {
  const [s, courts, rot] = await Promise.all([processSvc.getSettings(), processSvc.courts(), processSvc.rotationState()]);
  res.json({ ...s, remarks: processSvc.REMARKS, rotation: rot,
    courts: courts.map(c => ({ key: c.key, name: c.name, courtNo: c.courtNo, roman: processSvc.roman(c.courtNo) })),
    me: { inProcess: inProcess(req.user), registrar: isRegistrar(req.user), chiefJudge: isCJ(req.user) } });
}));

router.put('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Only an administrator can change the Process Registry settings.');
  let s;
  try { s = await processSvc.setSettings(req.body || {}); } catch (e) { throw new HttpError(e.status || 500, e.message); }
  await audit.log(req, 'process_settings_changed', { details: { fields: Object.keys(req.body || {}) } });
  res.json(s);
}));

// The courts whose register this person keeps: the court registries they are in.
const myCourts = async (u) => (await Unit.find({ type: 'registry', active: true, key: { $in: u.unitKeys } }, 'key').lean()).map(x => x.key).filter(k => inCourt(u, k));
// New cases: assigned to one of those courts, the file not yet received.
const newCasesQuery = (keys) => ({ status: { $in: ['assigned', 'dispatched'] }, assignedUnit: { $in: keys }, earlier: { $ne: true } });

// Numbers for the menu badges.
router.get('/counts', wrap(async (req, res) => {
  const courts = await myCourts(req.user);
  const [awaiting, toRegister, newCases] = await Promise.all([
    isCJ(req.user) ? Case.countDocuments({ status: 'awaiting_assignment' }) : 0,
    isRegistrar(req.user) && inProcess(req.user) ? Case.countDocuments({ status: 'submitted' }) : 0,
    courts.length ? Case.countDocuments({ ...newCasesQuery(courts), status: 'dispatched' }) : 0 // files to receive
  ]);
  res.json({ awaitingAssignment: awaiting, toRegister, newCases });
}));

// New cases for Home: assigned to this person's courts, file not yet received.
router.get('/new-cases', wrap(async (req, res) => {
  const courts = await myCourts(req.user);
  const [list, units] = await Promise.all([courts.length ? Case.find(newCasesQuery(courts)).sort({ assignedAt: -1 }).limit(100) : [], unitNames()]);
  res.json({ cases: list.map(c => serialize(c, units)) });
}));

// ── Cases ──
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
router.get('/cases', wrap(async (req, res) => {
  const q = { earlier: { $ne: true } };
  if (req.query.status) q.status = { $in: String(req.query.status).split(',') };
  if (!inProcess(req.user)) {
    if (!isCJ(req.user)) throw new HttpError(403, 'The Process Registry list is for its staff and the Hon. Chief Judge.');
    q.status = { $in: (req.query.status ? String(req.query.status).split(',') : ['awaiting_assignment']).filter(s => ['awaiting_assignment', 'assigned', 'dispatched', 'received', 'disposed'].includes(s)) };
  }
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q).slice(0, 80)), 'i');
    q.$or = [{ suitNumber: rx }, { firstParty: rx }, { secondParty: rx }, { nature: rx }, { receiptNumber: rx }, { 'invoice.reference': rx }];
  }
  const [list, units] = await Promise.all([Case.find(q).sort({ updatedAt: -1 }).limit(500), unitNames()]);
  res.json({ cases: list.map(c => serialize(c, units)) });
}));

router.get('/cases/:id', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  const extra = {};
  if (c.verifyUrl && c.assignment) extra.qrDataUrl = await verification.qrDataUrl(c.verifyUrl);
  if (c.assignment) extra.signatureUrl = `/api/process/cases/${c._id}/signature`;
  res.json({ case: serialize(c, await unitNames(), extra) });
}));

router.post('/cases', wrap(async (req, res) => {
  if (!inProcess(req.user) || !(can(req.user, 'create') || isRegistrar(req.user))) throw new HttpError(403, 'Only Process Registry staff file new cases.');
  const fields = await cleanCase({ filedOn: '', fees: [], ...req.body });
  if (!fields.caseType) throw new HttpError(400, 'Choose the case type.');
  if (!fields.firstParty || !fields.secondParty) throw new HttpError(400, 'Enter both parties.');
  const c = await Case.create({ ...fields, status: 'draft', createdBy: req.user._id, createdByName: req.user.fullName });
  await audit.log(req, 'case_filed', { unitKey: 'process', details: { caseId: String(c._id) } });
  res.status(201).json({ case: serialize(c, await unitNames()) });
}));

const editable = (c) => ['draft', 'returned', 'submitted'].includes(c.status);
function assertEdit(user, c) {
  if (!inProcess(user)) throw new HttpError(403, 'Only Process Registry staff change a filing.');
  if (!editable(c)) throw new HttpError(409, 'A registered case can no longer be changed here.');
  if (c.status === 'submitted' && !isRegistrar(user)) throw new HttpError(409, 'This filing is with the Process Registrar. Ask them to return it if it needs changing.');
}

router.put('/cases/:id', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  assertEdit(req.user, c);
  Object.assign(c, await cleanCase(req.body));
  if (!c.firstParty || !c.secondParty) throw new HttpError(400, 'Enter both parties.');
  await c.save();
  await audit.log(req, 'case_updated', { unitKey: 'process', details: { caseId: String(c._id) } });
  res.json({ case: serialize(c, await unitNames()) });
}));

router.delete('/cases/:id', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!['draft', 'returned'].includes(c.status) || !inProcess(req.user)) throw new HttpError(409, 'Only a filing not yet registered can be deleted.');
  if (String(c.createdBy) !== String(req.user._id) && !can(req.user, 'delete') && !isRegistrar(req.user)) throw new HttpError(403, 'You may delete only your own filings.');
  await Case.deleteOne({ _id: c._id });
  await audit.log(req, 'case_deleted', { unitKey: 'process', details: { caseId: String(c._id), parties: `${c.firstParty} v. ${c.secondParty}` } });
  res.json({ deleted: true });
}));

// The payment receipt: a photo or PDF, kept privately.
router.post('/cases/:id/receipt', upload.single('file'), wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  assertEdit(req.user, c);
  if (!req.file) throw new HttpError(400, 'Choose the receipt file.');
  try { c.receipt = await fileStore.save(req.file.buffer, req.file.originalname); }
  catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: true }); }
  await c.save();
  await audit.log(req, 'case_receipt_uploaded', { unitKey: 'process', details: { caseId: String(c._id), bytes: req.file.size } });
  res.json({ case: serialize(c, await unitNames()) });
}));

router.get('/cases/:id/receipt', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!(inProcess(req.user) || isCJ(req.user))) throw new HttpError(403, 'The receipt is for the Process Registry and the Hon. Chief Judge.');
  if (!c.receipt) throw new HttpError(404, 'No receipt was uploaded.');
  const f = await fileStore.read(c.receipt);
  if (!f) throw new HttpError(404, 'The receipt file is missing.');
  res.set('Content-Type', f.contentType).set('Content-Disposition', `inline; filename="${c.receipt.name || 'receipt'}"`).set('Cache-Control', 'private, no-store');
  res.send(f.buffer);
}));

router.get('/cases/:id/signature', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!c.assignment || !c.assignment.image) throw new HttpError(404, 'Not signed.');
  const img = await store.read(c.assignment.image);
  if (!img) throw new HttpError(404, 'Signature image missing.');
  res.set('Content-Type', img.contentType).set('Cache-Control', 'private, max-age=86400').send(img.buffer);
}));

// The invoice for the filer to go and pay. Issuing it again (after the fees
// change) keeps the same reference.
router.post('/cases/:id/invoice', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  assertEdit(req.user, c);
  if (c.official) throw new HttpError(400, 'An official case has no filing fee, so no invoice.');
  if (!(c.feeTotal > 0)) throw new HttpError(400, 'Enter the filing fees first.');
  const reference = (c.invoice && c.invoice.reference) || await processSvc.nextInvoice();
  c.invoice = { reference, issuedAt: new Date(), issuedByName: req.user.fullName, fees: c.fees.map(f => ({ item: f.item, amount: f.amount, qty: f.qty })), total: c.feeTotal };
  await c.save();
  await audit.log(req, 'case_invoice_issued', { unitKey: 'process', details: { caseId: String(c._id), reference, total: c.feeTotal } });
  await caseEmail.notify(c, 'invoice');
  res.json({ case: serialize(c, await unitNames()) });
}));

// What registration needs: a fee and its receipt, unless the case is official.
function missingForRegistration(c, s) {
  if (!c.caseType || !c.firstParty || !c.secondParty) return 'Enter the case type and both parties.';
  if (!c.nature) return 'Enter the nature of the case.';
  if (!c.official) {
    if (!(c.feeTotal > 0)) return 'Enter the filing fees, or mark the case Official (no fee).';
    if (!c.receiptNumber) return 'Enter the receipt number.';
    if (!c.receipt && s.receiptRequired) return 'Upload the payment receipt.';
  }
  return null;
}

router.post('/cases/:id/submit', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!inProcess(req.user) || !['draft', 'returned'].includes(c.status)) throw new HttpError(409, 'Only a draft or returned filing can be sent to the Process Registrar.');
  const missing = missingForRegistration(c, await processSvc.getSettings());
  if (missing) throw new HttpError(400, missing);
  c.status = 'submitted';
  await c.save();
  await audit.log(req, 'case_submitted', { unitKey: 'process', details: { caseId: String(c._id) } });
  await tell(await User.find({ active: true, signerRoles: 'process_registrar' }), `New filing to register: ${c.firstParty} v. ${c.secondParty}.`, 'process', 'Filing to register');
  res.json({ case: serialize(c, await unitNames()) });
}));

router.post('/cases/:id/return', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!isRegistrar(req.user) || c.status !== 'submitted') throw new HttpError(409, 'Only the Process Registrar returns a filing waiting to be registered.');
  const comment = String(req.body.comment || '').trim().slice(0, 2000);
  if (!comment) throw new HttpError(400, 'Say what must be corrected.');
  Object.assign(c, { status: 'returned', returnComment: comment, returnedByName: req.user.fullName });
  await c.save();
  await audit.log(req, 'case_returned', { unitKey: 'process', details: { caseId: String(c._id), comment } });
  await tell([await User.findById(c.createdBy)], `Your filing ${c.firstParty} v. ${c.secondParty} was returned: ${comment}`, 'process', 'Filing returned');
  res.json({ case: serialize(c, await unitNames()) });
}));

// Registration: the next suit number of the type, and the court proposed in turn.
router.post('/cases/:id/register', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!isRegistrar(req.user)) throw new HttpError(403, 'Only the Process Registrar registers cases.');
  if (!['draft', 'submitted', 'returned'].includes(c.status)) throw new HttpError(409, 'This case is already registered.');
  const missing = missingForRegistration(c, await processSvc.getSettings());
  if (missing) throw new HttpError(400, missing);
  if (!(await processSvc.getSettings()).caseTypes.some(t => t.key === c.caseType)) throw new HttpError(400, 'This case type no longer exists. Edit the filing and choose the case type.');
  let court, num;
  try {
    court = await processSvc.proposeCourt(c.efcc); // fails cleanly (no number used) if no court can take it
    num = await processSvc.nextNumber(c.caseType);
  } catch (e) { throw new HttpError(e.status || 500, e.message); }
  Object.assign(c, { ...num, status: 'awaiting_assignment', proposedUnit: court.key, registeredBy: req.user._id, registeredByName: req.user.fullName,
    registeredAt: new Date(), caseNos: [catalogue.normalizeCase(num.suitNumber)], returnComment: undefined });
  await c.save();
  await caseEmail.notify(c, 'registered');
  await audit.log(req, 'case_registered', { unitKey: 'process', details: { caseId: String(c._id), suitNumber: num.suitNumber, proposed: court.key } });
  await tell(await User.find({ active: true, signerRoles: 'chief_judge' }), `${num.suitNumber} (${c.firstParty} v. ${c.secondParty}) is awaiting assignment. Proposed: ${court.name}.`, 'assign', 'Case awaiting assignment');
  res.json({ case: serialize(c, await unitNames()) });
}));

// Assignment by the Hon. Chief Judge, signed with their PIN.
router.post('/cases/:id/assign', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!isCJ(req.user)) throw new HttpError(403, 'Only the Hon. Chief Judge assigns cases.');
  if (c.status !== 'awaiting_assignment') throw new HttpError(409, 'This case is not awaiting assignment.');
  const unit = await Unit.findOne({ key: String(req.body.unitKey || c.proposedUnit), type: 'registry', active: true });
  if (!unit) throw new HttpError(400, 'Choose the court.');
  const me = await User.findById(req.user._id);
  if (!me.signature) throw new HttpError(400, 'Register your signature first (My Signature).');
  await verifyPin(me, String(req.body.pin || ''));
  c.status = 'assigned';
  c.assignedUnit = unit.key;
  c.assignedAt = new Date();
  c.assignment = { user: me._id, name: me.fullName, title: me.title, image: me.signature, signedAt: c.assignedAt };
  for (let i = 0; i < 5 && !c.verifyCode; i++) {
    const code = verification.newCode();
    if (!(await Case.exists({ verifyCode: code }))) c.verifyCode = code;
  }
  c.verifyUrl = `${verification.baseUrl(req)}/verify/${c.verifyCode}`;
  c.contentHash = verification.hashCase(c);
  await c.save();
  await caseEmail.notify(c, 'assigned', unit);
  await audit.log(req, 'case_assigned', { unitKey: unit.key, details: { caseId: String(c._id), suitNumber: c.suitNumber, court: unit.key, proposed: c.proposedUnit } });
  const roman = processSvc.roman(unit.courtNo);
  // Not to the Chief Judge who made the assignment, even where they sit in that court too.
  const others = { _id: { $ne: req.user._id } };
  await tell(await processPeople(others), `${c.suitNumber} was assigned to High Court No. ${roman}. Print the assignment slip and dispatch the file.`, 'process', `Case assigned to High Court No. ${roman}`);
  await tell(await User.find({ active: true, unitKeys: unit.key, ...others }), `New case ${c.suitNumber} (${c.firstParty} v. ${c.secondParty}) assigned to your court. The file will come from the Process Registry.`, `register:${unit.key}`, 'New case assigned to your court');
  res.json({ case: serialize(c, await unitNames()) });
}));

// Dispatch: the Process Registry sends the files of assigned cases to their
// courts (one or several at once). Each court is told its files are on the way.
router.post('/dispatch', wrap(async (req, res) => {
  if (!inProcess(req.user) || !(can(req.user, 'edit') || can(req.user, 'create') || isRegistrar(req.user))) throw new HttpError(403, 'Only the Process Registry dispatches files.');
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))].filter(id => mongoose.isValidObjectId(id)).slice(0, 200);
  if (!ids.length) throw new HttpError(400, 'Choose the files to dispatch.');
  const list = await Case.find({ _id: { $in: ids }, status: 'assigned' });
  if (!list.length) throw new HttpError(409, 'None of these files is waiting to be dispatched.');
  const now = new Date();
  for (const c of list) {
    Object.assign(c, { status: 'dispatched', dispatchedAt: now, dispatchedByName: req.user.fullName });
    await c.save();
    await audit.log(req, 'case_dispatched', { unitKey: c.assignedUnit, details: { caseId: String(c._id), suitNumber: c.suitNumber, court: c.assignedUnit } });
  }
  const byCourt = {};
  list.forEach(c => (byCourt[c.assignedUnit] = byCourt[c.assignedUnit] || []).push(c.suitNumber));
  for (const [key, nums] of Object.entries(byCourt)) {
    const what = nums.length === 1 ? `The file of ${nums[0]} has` : `${nums.length} files (${nums.join(', ')}) have`;
    await tell(await User.find({ active: true, unitKeys: key, _id: { $ne: req.user._id } }), `${what} been dispatched to your court. Mark each file received when it arrives.`, `register:${key}`, nums.length === 1 ? 'File dispatched to your court' : 'Files dispatched to your court');
  }
  const units = await unitNames();
  res.json({ dispatched: list.length, cases: list.map(c => serialize(c, units)) });
}));

// ── A court's Case Register ──
router.get('/register', wrap(async (req, res) => {
  const unitKey = String(req.query.unitKey || '');
  if (!inCourt(req.user, unitKey)) throw new HttpError(403, 'You do not have access to this court\'s register.');
  const [list, units] = await Promise.all([
    Case.find({ assignedUnit: unitKey, status: { $in: ['assigned', 'dispatched', 'received', 'disposed'] } }).sort({ assignedAt: -1 }).limit(2000),
    unitNames()
  ]);
  res.json({ cases: list.map(c => serialize(c, units)), remarks: processSvc.REMARKS });
}));

function assertCourtWork(user, c) {
  if (!inCourt(user, c.assignedUnit) || !(can(user, 'edit') || can(user, 'create'))) throw new HttpError(403, 'Only staff of the assigned court update its register.');
}

router.post('/cases/:id/received', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  assertCourtWork(req.user, c);
  if (c.status === 'assigned') throw new HttpError(409, 'The file is still at the Process Registry. It can be marked received once the Process Registry dispatches it.');
  if (c.status !== 'dispatched') throw new HttpError(409, 'The file was already marked as received.');
  Object.assign(c, { status: 'received', receivedAt: new Date(), receivedByName: req.user.fullName });
  await c.save();
  await caseEmail.notify(c, 'received', await Unit.findOne({ key: c.assignedUnit }));
  await audit.log(req, 'case_file_received', { unitKey: c.assignedUnit, details: { caseId: String(c._id), suitNumber: c.suitNumber } });
  res.json({ case: serialize(c, await unitNames()) });
}));

router.post('/cases/:id/disposal', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  assertCourtWork(req.user, c);
  if (!['assigned', 'dispatched', 'received', 'disposed'].includes(c.status)) throw new HttpError(409, 'This case is not in a court register.');
  let remark = String(req.body.remark || '').trim();
  if (remark === 'Other') remark = String(req.body.other || '').trim();
  if (!remark) throw new HttpError(400, 'Choose the remark, or type it under Other.');
  const date = DAY.test(req.body.date || '') ? req.body.date : today();
  c.disposal = { remark: remark.slice(0, 300), date, byName: req.user.fullName, at: new Date() };
  c.status = 'disposed';
  if (!c.receivedAt) Object.assign(c, { receivedAt: new Date(), receivedByName: req.user.fullName });
  await c.save();
  await audit.log(req, 'case_disposed', { unitKey: c.assignedUnit, details: { caseId: String(c._id), suitNumber: c.suitNumber, remark } });
  res.json({ case: serialize(c, await unitNames()) });
}));

// A case filed before the system, entered by the court registry.
router.post('/register/earlier', wrap(async (req, res) => {
  const unitKey = String(req.body.unitKey || '');
  const unit = await Unit.findOne({ key: unitKey, type: 'registry' });
  if (!unit || !inCourt(req.user, unitKey) || !(can(req.user, 'create') || can(req.user, 'edit'))) throw new HttpError(403, 'Only staff of this court add to its register.');
  const suitNumber = String(req.body.suitNumber || '').trim().slice(0, 60);
  if (!suitNumber) throw new HttpError(400, 'Enter the case number.');
  if (await Case.exists({ suitNumber })) throw new HttpError(409, `${suitNumber} is already in a register.`);
  const s = await processSvc.getSettings();
  const caseType = s.caseTypes.some(t => t.key === req.body.caseType) ? req.body.caseType : s.caseTypes[0].key;
  // A typed date is kept at midday, so it reads as the same day in any time zone.
  const typed = (v) => DAY.test(v || '') ? new Date(v + 'T12:00:00Z') : null;
  const c = await Case.create({
    caseType, suitNumber, earlier: true, caseNos: [catalogue.normalizeCase(suitNumber)],
    firstParty: String(req.body.firstParty || '').trim().slice(0, 1000), secondParty: String(req.body.secondParty || '').trim().slice(0, 1000),
    nature: String(req.body.nature || '').trim().slice(0, 300),
    filedOn: DAY.test(req.body.filedOn || '') ? req.body.filedOn : undefined,
    status: 'received', assignedUnit: unitKey, assignedAt: typed(req.body.assignedOn) || undefined,
    receivedAt: typed(req.body.receivedOn) || new Date(),
    receivedByName: req.user.fullName, createdBy: req.user._id, createdByName: req.user.fullName
  });
  await audit.log(req, 'case_earlier_added', { unitKey, details: { caseId: String(c._id), suitNumber } });
  res.status(201).json({ case: serialize(c, await unitNames()) });
}));

// ── Summary for the Process Registry ──
router.get('/summary', wrap(async (req, res) => {
  if (!inProcess(req.user) && !isCJ(req.user)) throw new HttpError(403, 'The summary is for the Process Registry.');
  const from = DAY.test(req.query.from || '') ? new Date(req.query.from + 'T00:00:00') : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = DAY.test(req.query.to || '') ? new Date(req.query.to + 'T23:59:59.999') : new Date();
  const range = { $gte: from, $lte: to };
  const [s, units, registered, assigned, disposed, awaiting, toRegister] = await Promise.all([
    processSvc.getSettings(), unitNames(),
    Case.find({ registeredAt: range }, 'caseType official feeTotal').lean(),
    Case.find({ assignedAt: range, earlier: { $ne: true } }, 'assignedUnit').lean(),
    Case.countDocuments({ 'disposal.at': range }),
    Case.countDocuments({ status: 'awaiting_assignment' }),
    Case.countDocuments({ status: 'submitted' })
  ]);
  const byType = s.caseTypes.map(t => ({ label: t.label, count: registered.filter(c => c.caseType === t.key).length }));
  const byCourt = {};
  assigned.forEach(c => { byCourt[c.assignedUnit] = (byCourt[c.assignedUnit] || 0) + 1; });
  res.json({
    from, to, registered: registered.length, official: registered.filter(c => c.official).length,
    fees: Math.round(registered.reduce((n, c) => n + (c.official ? 0 : c.feeTotal || 0), 0) * 100) / 100,
    byType, byCourt: Object.entries(byCourt).map(([k, n]) => ({ name: units[k] ? units[k].name : k, count: n })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    disposed, awaiting, toRegister
  });
}));

module.exports = router;
module.exports.inProcess = inProcess;

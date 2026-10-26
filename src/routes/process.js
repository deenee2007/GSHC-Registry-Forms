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
const { Case, CaseDocument, CaseProcess, Unit, User, Notification, DOC_TYPES, receiptKey } = require('../models');
const processSvc = require('../services/process');
const fileStore = require('../services/fileStore');
const store = require('../services/signatureStore');
const verification = require('../services/verification');
const catalogue = require('../forms/catalogue');
const audit = require('../services/audit');
const mail = require('../services/mail');
const settings = require('../services/settings');
const caseEmail = require('../services/caseEmail');
const registerImport = require('../services/registerImport');
const { verifyPin } = require('./me');
const { HttpError, requireLogin, canAccessUnit, can, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: fileStore.MAX_BYTES, files: 1 } });
const docMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: fileStore.DOC_MAX_BYTES, files: 1 } }).single('file');
const docUpload = (req, res, next) => docMulter(req, res, (err) => next(err && err.code === 'LIMIT_FILE_SIZE'
  ? new HttpError(400, 'The file must be under 10 MB. Scan at 200 dpi in greyscale, or upload a long document in parts.') : err));

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
    counsel: o.counsel, counselAddress: o.counselAddress, firstPartyAddress: o.firstPartyAddress || '', secondPartyAddress: o.secondPartyAddress || '', filedOn: o.filedOn, efcc: o.efcc, official: o.official,
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

// Fee lines from the schedule (its amounts, not the browser's) or typed in
// (Other), and their total.
function computeFees(lines, s) {
  if (!Array.isArray(lines)) throw new HttpError(400, 'Invalid fees.');
  const fees = lines.slice(0, 50).map(f => {
    const qty = Math.max(1, Math.min(1000, parseInt(f.qty, 10) || 1));
    const listed = s.fees.find(x => x.item === f.item);
    const amount = listed ? listed.amount : Number(f.amount);
    if (!String(f.item || '').trim()) throw new HttpError(400, 'Every fee line needs a description.');
    if (!(amount >= 0)) throw new HttpError(400, `Enter the amount for ${f.item}.`);
    return { item: String(f.item).trim().slice(0, 120), amount, qty };
  });
  return { fees, feeTotal: Math.round(fees.reduce((n, f) => n + f.amount * f.qty, 0) * 100) / 100 };
}

// One receipt pays for one filing. A receipt number already on another
// filing (a new case, or a process filed later) is refused; a registrar or
// an administrator may confirm a genuine exception, which is audited.
const mayConfirmReceipt = (u) => isAdmin(u) || u.signerRoles.some(r => ['process_registrar', 'registrar', 'chief_registrar'].includes(r));
async function checkReceipt(req, number, own = {}) {
  const key = receiptKey(number);
  if (!key) return;
  const [c, p] = await Promise.all([
    Case.findOne({ receiptKey: key, ...(own.caseId ? { _id: { $ne: own.caseId } } : {}) }, 'suitNumber firstParty secondParty filedOn').lean(),
    CaseProcess.findOne({ receiptKey: key, ...(own.processId ? { _id: { $ne: own.processId } } : {}) }, 'case processType filedOn').lean()
  ]);
  if (!c && !p) return;
  const on = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'an earlier day';
  let where;
  if (c) where = `${c.suitNumber || `the filing ${[c.firstParty, c.secondParty].filter(Boolean).join(' v. ')} (not yet numbered)`}, filed on ${on(c.filedOn)}`;
  else { const pc = await Case.findById(p.case, 'suitNumber').lean(); where = `${p.processType} in ${pc ? pc.suitNumber : 'another case'}, filed on ${on(p.filedOn)}`; }
  if (req.body && req.body.confirmDuplicateReceipt && mayConfirmReceipt(req.user)) {
    await audit.log(req, 'receipt_used_twice_confirmed', { details: { receiptNumber: number, alsoOn: where } });
    return;
  }
  throw Object.assign(new HttpError(409, `Receipt number ${number} is already on ${where}. One receipt pays for one filing.` +
    (mayConfirmReceipt(req.user) ? ' If it truly covers both, confirm to go ahead.' : ' If it truly covers both, ask the registrar or an administrator to confirm it.')),
  { extra: { duplicateReceipt: true, canConfirm: mayConfirmReceipt(req.user) } });
}

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
  ['counselAddress', 'firstPartyAddress', 'secondPartyAddress'].forEach(k => str(k, 1000));
  if (body.filedOn !== undefined) {
    if (body.filedOn && !DAY.test(body.filedOn)) throw new HttpError(400, 'Enter the date of filing.');
    out.filedOn = body.filedOn || today();
  }
  if (body.efcc !== undefined) out.efcc = !!body.efcc;
  if (body.official !== undefined) out.official = !!body.official;
  if (out.efcc) out.official = true; // EFCC matters bear no filing fee
  if (body.fees !== undefined) Object.assign(out, computeFees(body.fees, s));
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
  res.json({ ...s, remarks: processSvc.REMARKS, docTypes: DOC_TYPES, rotation: rot,
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
  if (!fields.official) await checkReceipt(req, fields.receiptNumber);
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
  const changes = await cleanCase(req.body);
  if (changes.receiptNumber !== undefined && receiptKey(changes.receiptNumber) !== receiptKey(c.receiptNumber)) await checkReceipt(req, changes.receiptNumber, { caseId: c._id });
  Object.assign(c, changes);
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
  const docs = await CaseDocument.find({ case: c._id });
  await Promise.all(docs.map(d => fileStore.remove(d.file)));
  await CaseDocument.deleteMany({ case: c._id });
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

// ── Scanned documents of a case ──
// The Process Registry (at filing) and the assigned court's staff upload;
// everyone who can see the case can open them. The uploader may delete a
// document on the day it was uploaded; after that, only an administrator.
const canUploadDoc = (u, c) => (inProcess(u) && (can(u, 'create') || can(u, 'edit') || isRegistrar(u))) ||
  (inCourt(u, c.assignedUnit) && (can(u, 'create') || can(u, 'edit')));
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const canDeleteDoc = (u, d) => isAdmin(u) || (String(d.uploadedBy) === String(u._id) && sameDay(d.createdAt, new Date()));
const serializeDoc = (d, u) => ({
  id: String(d._id), title: d.title, docType: d.docType, filedOn: d.filedOn || '',
  name: d.file.name, contentType: d.file.contentType, bytes: d.file.bytes,
  uploadedByName: d.uploadedByName, uploadedAt: d.createdAt, url: `/api/process/documents/${d._id}/file`, canDelete: canDeleteDoc(u, d),
  processId: d.process ? String(d.process) : null
});
async function loadDoc(id, user) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Document not found.');
  const d = await CaseDocument.findById(id);
  if (!d) throw new HttpError(404, 'Document not found.');
  return { d, c: await load(d.case, user) };
}

router.get('/cases/:id/documents', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  const docs = await CaseDocument.find({ case: c._id }).sort({ filedOn: 1, createdAt: 1 });
  res.json({ documents: docs.map(d => serializeDoc(d, req.user)), canUpload: canUploadDoc(req.user, c), docTypes: DOC_TYPES });
}));

router.post('/cases/:id/documents', docUpload, wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  if (!canUploadDoc(req.user, c)) throw new HttpError(403, 'Only the Process Registry and the staff of the assigned court add documents to this case.');
  if (!req.file) throw new HttpError(400, 'Choose the scanned document (PDF or photo).');
  let docType = String(req.body.docType || '').trim().slice(0, 80);
  if (docType === 'Others') docType = String(req.body.other || '').trim().slice(0, 80);
  const title = String(req.body.title || '').trim().slice(0, 200) || docType;
  if (!title) throw new HttpError(400, 'Give the document a title or choose its type.');
  const filedOn = DAY.test(req.body.filedOn || '') ? req.body.filedOn : undefined;
  let file;
  try { file = await fileStore.save(req.file.buffer, req.file.originalname, 'documents'); }
  catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: true }); }
  const unitKey = inCourt(req.user, c.assignedUnit) && !req.user.unitKeys.includes('process') ? c.assignedUnit : 'process';
  // Filed with a later process: it is linked to that process.
  const processId = mongoose.isValidObjectId(req.body.process || '') && await CaseProcess.exists({ _id: req.body.process, case: c._id }) ? req.body.process : undefined;
  const d = await CaseDocument.create({ case: c._id, title, docType, filedOn, file, unitKey, process: processId, uploadedBy: req.user._id, uploadedByName: req.user.fullName });
  await audit.log(req, 'case_document_added', { unitKey, details: { caseId: String(c._id), suitNumber: c.suitNumber, documentId: String(d._id), title, bytes: file.bytes } });
  res.status(201).json({ document: serializeDoc(d, req.user) });
}));

router.get('/documents/:id/file', wrap(async (req, res) => {
  const { d } = await loadDoc(req.params.id, req.user);
  const f = await fileStore.read(d.file);
  if (!f) throw new HttpError(404, 'The document file is missing.');
  const name = (d.file.name || 'document').replace(/"/g, '');
  res.set('Content-Type', f.contentType).set('Content-Disposition', `inline; filename="${name}"`).set('Cache-Control', 'private, no-store');
  res.send(f.buffer);
}));

router.delete('/documents/:id', wrap(async (req, res) => {
  const { d, c } = await loadDoc(req.params.id, req.user);
  if (!canDeleteDoc(req.user, d)) throw new HttpError(403, 'Only the person who uploaded it can delete a document, on the same day. After that, ask an administrator.');
  await fileStore.remove(d.file);
  await CaseDocument.deleteOne({ _id: d._id });
  await audit.log(req, 'case_document_deleted', { unitKey: d.unitKey, details: { caseId: String(c._id), suitNumber: c.suitNumber, title: d.title } });
  res.json({ deleted: true });
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

// A court's existing register book from an Excel or CSV sheet. Without
// commit=1 the rows are only checked (nothing saved), for the court to see
// what will be added; with it, the rows that passed are saved.
router.post('/register/import', upload.single('file'), wrap(async (req, res) => {
  const unitKey = String(req.body.unitKey || '');
  const unit = await Unit.findOne({ key: unitKey, type: 'registry' });
  if (!unit || !inCourt(req.user, unitKey) || !(can(req.user, 'create') || can(req.user, 'edit'))) throw new HttpError(403, 'Only staff of this court add to its register.');
  if (!req.file) throw new HttpError(400, 'Choose the Excel or CSV file of the register.');
  let result;
  try { result = await registerImport.analyse(req.file.buffer, req.file.originalname, unit); }
  catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: e.status === 400 }); }
  const rows = result.rows.map(({ doc, ...r }) => r);
  if (req.body.commit !== '1') return res.json({ preview: true, rows, toAdd: result.toAdd, skipped: result.skipped, columns: result.columns });
  if (!result.toAdd) throw new HttpError(400, 'No row can be added. Correct the rows listed and try again.');
  const done = await registerImport.commit(result, req.user);
  await audit.log(req, 'case_register_imported', { unitKey, details: { file: req.file.originalname, added: done.added, dates: done.dates, skipped: result.skipped + done.failed.length } });
  res.json({ added: done.added, dates: done.dates, skipped: result.skipped, failed: done.failed, rows });
}));

// ── Processes filed later in a case (motions, ...), at the court's registry ──
// The court's staff record the process, its fees and the invoice the filer
// takes to pay at revenue, then the receipt. No number of its own: it is
// recorded against the suit number.
const PROCESS_TYPES = ['Motion on notice', 'Motion ex parte'];
const serializeProcess = (p, s) => ({
  id: String(p._id), caseId: String(p.case), unitKey: p.unitKey, processType: p.processType, filedOn: p.filedOn,
  fees: p.fees || [], feeTotal: p.feeTotal || 0, receiptNumber: p.receiptNumber,
  invoice: p.invoice && p.invoice.reference ? { reference: p.invoice.reference, issuedAt: p.invoice.issuedAt, issuedByName: p.invoice.issuedByName, fees: p.invoice.fees || [], total: p.invoice.total || 0 } : null,
  receipt: p.receipt ? { name: p.receipt.name, contentType: p.receipt.contentType, uploadedAt: p.receipt.uploadedAt } : null,
  paid: !!p.receiptNumber && (!!p.receipt || !s.receiptRequired),
  createdByName: p.createdByName, createdAt: p.createdAt
});
async function loadProcess(id, user) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Process not found.');
  const p = await CaseProcess.findById(id);
  if (!p) throw new HttpError(404, 'Process not found.');
  const c = await load(p.case, user);
  return { p, c };
}
async function cleanProcess(body, s) {
  const out = {};
  if (body.processType !== undefined) {
    let t = String(body.processType || '').trim();
    if (t === 'Others') t = String(body.other || '').trim();
    if (!t) throw new HttpError(400, 'Choose the process, or type it under Others.');
    out.processType = t.slice(0, 120);
  }
  if (body.filedOn !== undefined) {
    if (body.filedOn && !DAY.test(body.filedOn)) throw new HttpError(400, 'Enter the date of filing.');
    out.filedOn = body.filedOn || today();
  }
  if (body.fees !== undefined) Object.assign(out, computeFees(body.fees, s));
  if (body.receiptNumber !== undefined) out.receiptNumber = String(body.receiptNumber || '').trim().slice(0, 300);
  return out;
}

router.get('/cases/:id/processes', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  const s = await processSvc.getSettings();
  const list = await CaseProcess.find({ case: c._id }).sort({ filedOn: 1, createdAt: 1 });
  res.json({ processes: list.map(p => serializeProcess(p, s)), processTypes: PROCESS_TYPES,
    canFile: !!c.assignedUnit && inCourt(req.user, c.assignedUnit) && (can(req.user, 'edit') || can(req.user, 'create')) });
}));

router.post('/cases/:id/processes', wrap(async (req, res) => {
  const c = await load(req.params.id, req.user);
  assertCourtWork(req.user, c);
  if (!['assigned', 'dispatched', 'received', 'disposed'].includes(c.status)) throw new HttpError(409, 'This case is not in a court register.');
  const s = await processSvc.getSettings();
  const fields = await cleanProcess({ filedOn: '', fees: [], ...req.body }, s);
  if (!fields.processType) throw new HttpError(400, 'Choose the process, or type it under Others.');
  await checkReceipt(req, fields.receiptNumber);
  const p = await CaseProcess.create({ ...fields, case: c._id, unitKey: c.assignedUnit, createdBy: req.user._id, createdByName: req.user.fullName, updatedByName: req.user.fullName });
  await audit.log(req, 'case_process_filed', { unitKey: c.assignedUnit, details: { caseId: String(c._id), suitNumber: c.suitNumber, processId: String(p._id), processType: p.processType, feeTotal: p.feeTotal } });
  res.status(201).json({ process: serializeProcess(p, s) });
}));

router.put('/processes/:id', wrap(async (req, res) => {
  const { p, c } = await loadProcess(req.params.id, req.user);
  assertCourtWork(req.user, c);
  const s = await processSvc.getSettings();
  const changes = await cleanProcess(req.body || {}, s);
  if (changes.receiptNumber !== undefined && receiptKey(changes.receiptNumber) !== receiptKey(p.receiptNumber)) await checkReceipt(req, changes.receiptNumber, { processId: p._id });
  Object.assign(p, changes, { updatedByName: req.user.fullName });
  await p.save();
  await audit.log(req, 'case_process_updated', { unitKey: p.unitKey, details: { caseId: String(c._id), suitNumber: c.suitNumber, processId: String(p._id) } });
  res.json({ process: serializeProcess(p, s) });
}));

router.delete('/processes/:id', wrap(async (req, res) => {
  const { p, c } = await loadProcess(req.params.id, req.user);
  assertCourtWork(req.user, c);
  if (p.receiptNumber) throw new HttpError(409, 'A process with its receipt recorded cannot be deleted.');
  await CaseProcess.deleteOne({ _id: p._id });
  await audit.log(req, 'case_process_deleted', { unitKey: p.unitKey, details: { caseId: String(c._id), suitNumber: c.suitNumber, processType: p.processType } });
  res.json({ deleted: true });
}));

router.post('/processes/:id/invoice', wrap(async (req, res) => {
  const { p, c } = await loadProcess(req.params.id, req.user);
  assertCourtWork(req.user, c);
  if (!(p.feeTotal > 0)) throw new HttpError(400, 'Enter the fees first.');
  const reference = (p.invoice && p.invoice.reference) || await processSvc.nextInvoice();
  p.invoice = { reference, issuedAt: new Date(), issuedByName: req.user.fullName, fees: p.fees.map(f => ({ item: f.item, amount: f.amount, qty: f.qty })), total: p.feeTotal };
  await p.save();
  await audit.log(req, 'case_process_invoice_issued', { unitKey: p.unitKey, details: { caseId: String(c._id), suitNumber: c.suitNumber, reference, total: p.feeTotal } });
  res.json({ process: serializeProcess(p, await processSvc.getSettings()) });
}));

router.post('/processes/:id/receipt', upload.single('file'), wrap(async (req, res) => {
  const { p, c } = await loadProcess(req.params.id, req.user);
  assertCourtWork(req.user, c);
  if (!req.file) throw new HttpError(400, 'Choose the receipt file.');
  try { p.receipt = await fileStore.save(req.file.buffer, req.file.originalname); }
  catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: true }); }
  await p.save();
  await audit.log(req, 'case_process_receipt_uploaded', { unitKey: p.unitKey, details: { caseId: String(c._id), processId: String(p._id), bytes: req.file.size } });
  res.json({ process: serializeProcess(p, await processSvc.getSettings()) });
}));

router.get('/processes/:id/receipt', wrap(async (req, res) => {
  const { p } = await loadProcess(req.params.id, req.user);
  if (!p.receipt) throw new HttpError(404, 'No receipt was uploaded.');
  const f = await fileStore.read(p.receipt);
  if (!f) throw new HttpError(404, 'The receipt file is missing.');
  res.set('Content-Type', f.contentType).set('Content-Disposition', `inline; filename="${(p.receipt.name || 'receipt').replace(/"/g, '')}"`).set('Cache-Control', 'private, no-store');
  res.send(f.buffer);
}));

// ── The fees list: every payment of a day or period, for reconciling with
// revenue. New filings (Process Registry) and processes filed later (the
// courts). The Process Registry sees its own, each court its own; the
// Chief Judge and administrators see all, or one unit.
router.get('/fees-list', wrap(async (req, res) => {
  const from = DAY.test(req.query.from || '') ? req.query.from : today();
  const to = DAY.test(req.query.to || '') ? req.query.to : from;
  if (from > to) throw new HttpError(400, 'The start of the period must come before its end.');
  const all = isAdmin(req.user) || isCJ(req.user);
  const mine = new Set([...(inProcess(req.user) ? ['process'] : []), ...(await myCourts(req.user))]);
  if (!all && !mine.size) throw new HttpError(403, 'The fees list is for the Process Registry, the court registries, the Chief Judge and administrators.');
  let keys = all ? null : [...mine];
  if (req.query.unitKey) {
    const k = String(req.query.unitKey);
    if (!all && !mine.has(k)) throw new HttpError(403, 'You do not have access to this unit\'s fees.');
    keys = [k];
  }
  const units = await unitNames();
  const nameOf = (k) => k === 'process' ? 'Process Registry' : (units[k] ? units[k].name : k);
  const rows = [];
  if (!keys || keys.includes('process')) {
    const cases = await Case.find({ earlier: { $ne: true }, official: { $ne: true }, feeTotal: { $gt: 0 }, filedOn: { $gte: from, $lte: to } }).lean();
    cases.forEach(c => rows.push({ date: c.filedOn, unitKey: 'process', unitName: 'Process Registry', caseId: String(c._id), suitNumber: c.suitNumber || '',
      parties: [c.firstParty, c.secondParty].filter(Boolean).join(' v. '), what: c.process ? `New case: ${c.process}` : 'New case',
      invoice: c.invoice ? c.invoice.reference : '', receiptNumber: c.receiptNumber || '', fees: c.fees || [], amount: c.feeTotal || 0 }));
  }
  const pq = { filedOn: { $gte: from, $lte: to }, ...(keys ? { unitKey: { $in: keys.filter(k => k !== 'process') } } : {}) };
  const procs = await CaseProcess.find(pq).lean();
  const casesById = Object.fromEntries((await Case.find({ _id: { $in: procs.map(p => p.case) } }, 'suitNumber firstParty secondParty').lean()).map(c => [String(c._id), c]));
  procs.forEach(p => { const c = casesById[String(p.case)] || {}; rows.push({ date: p.filedOn, unitKey: p.unitKey, unitName: nameOf(p.unitKey), caseId: String(p.case), suitNumber: c.suitNumber || '',
    parties: [c.firstParty, c.secondParty].filter(Boolean).join(' v. '), what: p.processType, invoice: p.invoice ? p.invoice.reference : '', receiptNumber: p.receiptNumber || '', fees: p.fees || [], amount: p.feeTotal || 0 }); });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.unitName.localeCompare(b.unitName, undefined, { numeric: true }) || String(a.suitNumber).localeCompare(String(b.suitNumber), undefined, { numeric: true }));
  const total = Math.round(rows.reduce((n, r) => n + r.amount, 0) * 100) / 100;
  const units_ = all ? [{ key: 'process', name: 'Process Registry' }, ...(await processSvc.courts()).map(u => ({ key: u.key, name: u.name }))] : [...mine].map(k => ({ key: k, name: nameOf(k) }));
  res.json({ from, to, rows, total, withoutReceipt: rows.filter(r => !r.receiptNumber).length, units: units_ });
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

router.canSeeCase = canSee;
module.exports = router;
module.exports.inProcess = inProcess;

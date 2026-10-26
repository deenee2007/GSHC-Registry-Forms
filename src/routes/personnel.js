/*
 * src/routes/personnel.js — the Nominal Roll of the Directorate of
 * Personnel: one record per member of staff (PSN unique), the record of
 * service, the documents folder and photo, the officers due to retire, the
 * import of a roll from Excel, and the settings (stations, ranks, cadres,
 * kinds of documents).
 *
 * personnel_view sees the roll; personnel_edit (Secret Registry staff, and
 * those the administrator gives it) also changes it and opens confidential
 * documents. Every opening of a record is in the audit log.
 */
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { Staff, StaffDocument, User, STAFF_STATUSES } = require('../models');
const personnel = require('../services/personnel');
const personnelImport = require('../services/personnelImport');
const fileStore = require('../services/fileStore');
const audit = require('../services/audit');
const { HttpError, requireLogin, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);
const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } }).single('file');
const docMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: fileStore.DOC_MAX_BYTES, files: 1 } }).single('file');
const docUpload = (req, res, next) => docMulter(req, res, (err) => next(err && err.code === 'LIMIT_FILE_SIZE'
  ? new HttpError(400, 'The file must be under 10 MB. Scan at 200 dpi in greyscale, or upload a long document in parts.') : err));

const canEdit = (u) => isAdmin(u) || u.privileges.includes('personnel_edit');
const canView = (u) => canEdit(u) || u.privileges.includes('personnel_view');
const mustView = (req) => { if (!canView(req.user)) throw new HttpError(403, 'The Nominal Roll is for the Directorate of Personnel and those the administrator allows.'); };
const mustEdit = (req) => { if (!canEdit(req.user)) throw new HttpError(403, 'Only those allowed to edit the Nominal Roll (Secret Registry staff) can change it.'); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const long = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IN_SERVICE = ['in_service', 'on_leave', 'suspended'];

// Whole years between two dates.
function years(from, to = today()) {
  if (!DAY.test(from || '')) return null;
  let n = Number(to.slice(0, 4)) - Number(from.slice(0, 4));
  if (to.slice(5) < from.slice(5)) n--;
  return n;
}
const LIST_FIELDS = 'psn name title sex rank cadre gl step qualification dob dofa dopa confirmedOn lga station contract contractEnds status retiresOn retiresBy checkDates photo.contentType updatedAt';
function brief(s) {
  return {
    id: String(s._id), psn: s.psn, name: s.name, title: s.title || '', sex: s.sex, rank: s.rank, cadre: s.cadre, gl: s.gl, step: s.step,
    qualification: s.qualification, dob: s.dob, dofa: s.dofa, dopa: s.dopa, confirmedOn: s.confirmedOn, lga: s.lga, station: s.station,
    contract: !!s.contract, contractEnds: s.contractEnds, status: s.status, statusLabel: personnel.STATUS_LABELS[s.status] || s.status,
    retiresOn: s.retiresOn, retiresBy: s.retiresBy, age: years(s.dob), service: years(s.dofa), checkDates: !!s.checkDates,
    hasPhoto: !!(s.photo && s.photo.contentType)
  };
}
function full(s, u) {
  return {
    ...brief(s), qualifications: s.qualifications || [], phone: s.phone, email: s.email, address: s.address,
    nextOfKin: s.nextOfKin || { name: '', relationship: '', phone: '' }, statusDate: s.statusDate, user: s.user ? String(s.user) : null,
    history: [...(s.history || [])].reverse(), createdAt: s.createdAt, createdByName: s.createdByName, updatedByName: s.updatedByName,
    canEdit: canEdit(u)
  };
}
async function load(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Staff record not found.');
  const s = await Staff.findById(id);
  if (!s) throw new HttpError(404, 'Staff record not found.');
  return s;
}

// ── Settings ──
router.get('/settings', wrap(async (req, res) => {
  mustView(req);
  res.json({ ...(await personnel.getSettings()), lgas: personnel.LGAS, gls: personnel.GLS, statuses: STAFF_STATUSES.map(k => ({ key: k, label: personnel.STATUS_LABELS[k] })),
    me: { canEdit: canEdit(req.user), admin: isAdmin(req.user) } });
}));
router.put('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Only an administrator changes the personnel settings.');
  const s = await personnel.setSettings(req.body || {});
  await audit.log(req, 'personnel_settings_changed', { details: { stations: s.stations.length, ranks: s.ranks.length } });
  res.json(s);
}));

// ── The roll ──
router.get('/staff', wrap(async (req, res) => {
  mustView(req);
  const q = {};
  for (const k of ['station', 'cadre', 'gl', 'lga', 'rank']) if (req.query[k]) q[k] = String(req.query[k]);
  if (req.query.status === 'serving') q.status = { $in: IN_SERVICE };
  else if (req.query.status) q.status = String(req.query.status);
  if (req.query.sex) q.sex = String(req.query.sex);
  if (req.query.contract === '1') q.contract = true;
  if (req.query.checkDates === '1') q.checkDates = true;
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 80)), 'i');
    q.$or = [{ name: rx }, { psn: rx }, { rank: rx }, { station: rx }];
  }
  const list = await Staff.find(q, LIST_FIELDS).sort({ name: 1 }).limit(10000).lean();
  res.json({ staff: list.map(brief), total: await Staff.countDocuments({}) });
}));

// Officers in service who retire within the months asked for (or are past it).
router.get('/due-to-retire', wrap(async (req, res) => {
  mustView(req);
  const months = Math.min(60, Math.max(1, Number(req.query.months) || 12));
  const d = new Date(); d.setMonth(d.getMonth() + months);
  const until = d.toISOString().slice(0, 10);
  const list = await Staff.find({ status: { $in: IN_SERVICE }, retiresOn: { $ne: '', $lte: until } }, LIST_FIELDS).sort({ retiresOn: 1 }).lean();
  res.json({ months, until, staff: list.map(brief) });
}));

router.get('/staff/:id', wrap(async (req, res) => {
  mustView(req);
  const s = await load(req.params.id);
  await audit.log(req, 'staff_record_opened', { details: { staffId: String(s._id), psn: s.psn } });
  res.json({ staff: full(s, req.user) });
}));

const TEXT = { name: 200, title: 40, rank: 120, cadre: 60, qualification: 200, lga: 40, station: 120, phone: 40, email: 120, address: 300 };
const DATE_FIELDS = ['dob', 'dofa', 'dopa', 'confirmedOn', 'contractEnds'];
const LABEL = { psn: 'PSN', name: 'Name', title: 'Title', sex: 'Sex', rank: 'Rank', cadre: 'Cadre', gl: 'GL', step: 'Step', qualification: 'Highest qualification',
  dob: 'Date of birth', dofa: 'Date of first appointment', dopa: 'Date of present appointment', confirmedOn: 'Date of confirmation', lga: 'LGA',
  station: 'Station', contract: 'Contract', contractEnds: 'Contract end date', phone: 'Phone', email: 'Email', address: 'Address', nextOfKin: 'Next of kin',
  qualifications: 'Qualifications', user: 'Sign in account' };
async function clean(body, s) {
  const out = {};
  if (body.psn !== undefined) {
    out.psn = String(body.psn || '').trim().slice(0, 40);
    if (!out.psn) throw new HttpError(400, 'Enter the PSN.');
  }
  for (const [k, max] of Object.entries(TEXT)) if (body[k] !== undefined) out[k] = String(body[k] || '').trim().replace(/\s+/g, ' ').slice(0, max);
  if (out.name !== undefined && !out.name) throw new HttpError(400, 'Enter the name.');
  if (out.email !== undefined) out.email = out.email.toLowerCase();
  if (out.lga && !personnel.LGAS.includes(out.lga)) throw new HttpError(400, 'Choose the local government from the list.');
  if (out.rank !== undefined && body.cadre === undefined) {
    const r = personnel.rankFinder(s.ranks)(out.rank);
    if (r) { out.rank = r.name; out.cadre = r.cadre; }
  }
  if (body.sex !== undefined) { out.sex = ['M', 'F'].includes(body.sex) ? body.sex : ''; }
  if (body.gl !== undefined) {
    out.gl = body.gl ? personnel.readGl(body.gl) : '';
    if (out.gl === null) throw new HttpError(400, 'Choose the grade level (01 to 17, or Cons.).');
  }
  if (body.step !== undefined) {
    out.step = body.step === '' || body.step === null ? null : Number(body.step);
    if (out.step !== null && !(Number.isInteger(out.step) && out.step >= 1 && out.step <= 15)) throw new HttpError(400, 'The step is a number from 1 to 15.');
  }
  for (const k of DATE_FIELDS) if (body[k] !== undefined) {
    out[k] = String(body[k] || '');
    if (out[k] && !DAY.test(out[k])) throw new HttpError(400, `Enter the ${LABEL[k].toLowerCase()} as a date.`);
  }
  if (body.contract !== undefined) out.contract = !!body.contract;
  if (body.nextOfKin !== undefined) {
    const n = body.nextOfKin || {};
    out.nextOfKin = { name: String(n.name || '').trim().slice(0, 200), relationship: String(n.relationship || '').trim().slice(0, 60), phone: String(n.phone || '').trim().slice(0, 40) };
  }
  if (body.qualifications !== undefined) {
    out.qualifications = (Array.isArray(body.qualifications) ? body.qualifications : []).slice(0, 20)
      .map(x => ({ name: String(x.name || '').trim().slice(0, 200), institution: String(x.institution || '').trim().slice(0, 200), year: String(x.year || '').trim().slice(0, 10) }))
      .filter(x => x.name);
  }
  return out;
}
const shown = (k, v) => v === true ? 'Yes' : v === false ? 'No' : DATE_FIELDS.includes(k) ? long(v) : k === 'nextOfKin' ? [v.name, v.relationship, v.phone].filter(Boolean).join(', ')
  : k === 'qualifications' ? v.map(x => x.name).join('; ') : v == null || v === '' ? 'blank' : String(v);

router.post('/staff', wrap(async (req, res) => {
  mustEdit(req);
  const fields = await clean({ psn: '', name: '', ...req.body }, await personnel.getSettings());
  if (await Staff.exists({ psn: fields.psn })) throw new HttpError(409, `PSN ${fields.psn} is already on the roll.`);
  const s = new Staff({ ...fields, createdByName: req.user.fullName,
    history: [{ kind: 'entered', date: today(), text: 'Entered on the Nominal Roll', byName: req.user.fullName, at: new Date() }] });
  await s.save();
  await audit.log(req, 'staff_record_added', { details: { staffId: String(s._id), psn: s.psn } });
  res.status(201).json({ staff: full(s, req.user) });
}));

// A correction: the changes are written into the record of service.
router.put('/staff/:id', wrap(async (req, res) => {
  mustEdit(req);
  const s = await load(req.params.id);
  const fields = await clean(req.body || {}, await personnel.getSettings());
  if (fields.psn && fields.psn !== s.psn && await Staff.exists({ psn: fields.psn })) throw new HttpError(409, `PSN ${fields.psn} is already on the roll.`);
  if (req.body.user !== undefined && isAdmin(req.user)) {
    const id = req.body.user && mongoose.isValidObjectId(req.body.user) ? req.body.user : null;
    if (id && !(await User.exists({ _id: id }))) throw new HttpError(400, 'Unknown sign in account.');
    if (String(s.user || '') !== String(id || '')) { fields.user = id; }
  }
  const changes = Object.keys(fields).filter(k => JSON.stringify(k === 'user' ? String(s.user || '') : s.toObject()[k] ?? '') !== JSON.stringify(k === 'user' ? String(fields.user || '') : fields[k] ?? ''));
  if (!changes.length) return res.json({ staff: full(s, req.user) });
  const text = changes.map(k => k === 'user' ? `${LABEL.user} ${fields.user ? 'linked' : 'unlinked'}` : `${LABEL[k] || k}: ${shown(k, s.toObject()[k])} to ${shown(k, fields[k])}`).join('; ');
  Object.assign(s, fields, { updatedByName: req.user.fullName });
  if (changes.some(k => DATE_FIELDS.includes(k))) s.checkDates = false;
  s.history.push({ kind: 'correction', date: today(), text: `Corrected: ${text}`.slice(0, 1500), byName: req.user.fullName, at: new Date() });
  await s.save();
  await audit.log(req, 'staff_record_corrected', { details: { staffId: String(s._id), psn: s.psn, fields: changes } });
  res.json({ staff: full(s, req.user) });
}));

// The dates checked and found right, with nothing to change.
router.post('/staff/:id/dates-checked', wrap(async (req, res) => {
  mustEdit(req);
  const s = await load(req.params.id);
  s.checkDates = false;
  s.history.push({ kind: 'correction', date: today(), text: 'Dates checked against the documents and found right', byName: req.user.fullName, at: new Date() });
  await s.save();
  res.json({ staff: full(s, req.user) });
}));

// The record of service: a promotion, a posting, confirmation, a change of status, or a note.
router.post('/staff/:id/events', wrap(async (req, res) => {
  mustEdit(req);
  const s = await load(req.params.id);
  const set = await personnel.getSettings();
  const b = req.body || {};
  const date = DAY.test(b.date || '') ? b.date : null;
  if (!date) throw new HttpError(400, 'Enter the date.');
  const note = String(b.note || '').trim().slice(0, 500);
  let text;
  if (b.kind === 'promotion') {
    const gl = personnel.readGl(b.gl);
    if (!gl) throw new HttpError(400, 'Choose the new grade level.');
    const r = String(b.rank || '').trim().slice(0, 120);
    if (!r) throw new HttpError(400, 'Enter the new rank.');
    const found = personnel.rankFinder(set.ranks)(r);
    const step = b.step === '' || b.step == null ? null : Number(b.step);
    text = `Promoted to ${found ? found.name : r}, GL ${gl}${step ? ` step ${step}` : ''} (from ${s.rank || 'no rank'}, GL ${s.gl || 'blank'})`;
    Object.assign(s, { rank: found ? found.name : r, cadre: found ? found.cadre : s.cadre, gl, step: Number.isInteger(step) ? step : s.step, dopa: date });
  } else if (b.kind === 'posting') {
    const st = String(b.station || '').trim().slice(0, 120);
    if (!st) throw new HttpError(400, 'Choose the station.');
    if (st === s.station) throw new HttpError(400, `The officer is already at ${st}.`);
    text = `Posted to ${st}${s.station ? ` (from ${s.station})` : ''}`;
    s.station = st;
  } else if (b.kind === 'confirmation') {
    text = 'Appointment confirmed';
    s.confirmedOn = date;
  } else if (b.kind === 'status') {
    if (!STAFF_STATUSES.includes(b.status)) throw new HttpError(400, 'Choose the status.');
    if (b.status === s.status) throw new HttpError(400, 'That is the status already.');
    text = `${personnel.STATUS_LABELS[b.status]} (was ${personnel.STATUS_LABELS[s.status]})`;
    Object.assign(s, { status: b.status, statusDate: date });
  } else if (b.kind === 'note') {
    if (!note) throw new HttpError(400, 'Write the note.');
    text = 'Note';
  } else throw new HttpError(400, 'Unknown entry.');
  s.history.push({ kind: b.kind, date, text: note && b.kind !== 'note' ? `${text}. ${note}` : b.kind === 'note' ? note : text, byName: req.user.fullName, at: new Date() });
  s.updatedByName = req.user.fullName;
  await s.save();
  await audit.log(req, `staff_${b.kind}`, { details: { staffId: String(s._id), psn: s.psn, text } });
  res.json({ staff: full(s, req.user) });
}));

// Removed only by an administrator: for a record entered by mistake.
router.delete('/staff/:id', wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Only an administrator removes a staff record.');
  const s = await load(req.params.id);
  const docs = await StaffDocument.find({ staff: s._id });
  await Promise.all(docs.map(d => fileStore.remove(d.file)));
  await StaffDocument.deleteMany({ staff: s._id });
  if (s.photo) await fileStore.remove(s.photo);
  await s.deleteOne();
  await audit.log(req, 'staff_record_removed', { details: { psn: s.psn, name: s.name, documents: docs.length } });
  res.json({ ok: true });
}));

// ── Photo (optional) ──
router.post('/staff/:id/photo', docUpload, wrap(async (req, res) => {
  mustEdit(req);
  const s = await load(req.params.id);
  if (!req.file) throw new HttpError(400, 'Choose the photo.');
  if (req.file.size > 2 * 1024 * 1024) throw new HttpError(400, 'The photo must be under 2 MB.');
  let file;
  try { file = await fileStore.save(req.file.buffer, req.file.originalname, 'staff-photos'); }
  catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: true }); }
  if (!/^image\//.test(file.contentType)) { await fileStore.remove(file); throw new HttpError(400, 'The photo must be a PNG or JPEG picture.'); }
  if (s.photo) await fileStore.remove(s.photo);
  s.photo = file;
  await s.save();
  res.json({ staff: full(s, req.user) });
}));
router.get('/staff/:id/photo', wrap(async (req, res) => {
  mustView(req);
  const s = await load(req.params.id);
  const f = s.photo && await fileStore.read(s.photo);
  if (!f) throw new HttpError(404, 'No photo.');
  res.set({ 'Content-Type': f.contentType, 'Cache-Control': 'private, no-store' }).send(f.buffer);
}));
router.delete('/staff/:id/photo', wrap(async (req, res) => {
  mustEdit(req);
  const s = await load(req.params.id);
  if (s.photo) await fileStore.remove(s.photo);
  s.photo = null;
  await s.save();
  res.json({ staff: full(s, req.user) });
}));

// ── Documents folder ──
const serializeDoc = (d, u) => {
  const open = !d.confidential || canEdit(u);
  return { id: String(d._id), title: open ? d.title : 'Confidential document', docType: open ? d.docType : '', date: d.date || '', confidential: !!d.confidential,
    name: open ? d.file.name : '', contentType: d.file.contentType, bytes: d.file.bytes, uploadedByName: d.uploadedByName, uploadedAt: d.createdAt,
    url: open ? `/api/personnel/documents/${d._id}/file` : null, canDelete: isAdmin(u) || (String(d.uploadedBy) === String(u._id) && new Date(d.createdAt).toDateString() === new Date().toDateString()) };
};
router.get('/staff/:id/documents', wrap(async (req, res) => {
  mustView(req);
  const s = await load(req.params.id);
  const docs = await StaffDocument.find({ staff: s._id }).sort({ date: 1, createdAt: 1 });
  res.json({ documents: docs.map(d => serializeDoc(d, req.user)), canUpload: canEdit(req.user), docTypes: (await personnel.getSettings()).docTypes });
}));
router.post('/staff/:id/documents', docUpload, wrap(async (req, res) => {
  mustEdit(req);
  const s = await load(req.params.id);
  if (!req.file) throw new HttpError(400, 'Choose the scanned document (PDF or photo).');
  let docType = String(req.body.docType || '').trim().slice(0, 80);
  if (docType === 'Others') docType = String(req.body.other || '').trim().slice(0, 80);
  const title = String(req.body.title || '').trim().slice(0, 200) || docType;
  if (!title) throw new HttpError(400, 'Give the document a title or choose its type.');
  let file;
  try { file = await fileStore.save(req.file.buffer, req.file.originalname, 'documents'); }
  catch (e) { throw Object.assign(new HttpError(e.status || 500, e.message), { expose: true }); }
  const d = await StaffDocument.create({ staff: s._id, title, docType, date: DAY.test(req.body.date || '') ? req.body.date : undefined,
    confidential: req.body.confidential === '1' || req.body.confidential === 'true', file, uploadedBy: req.user._id, uploadedByName: req.user.fullName });
  await audit.log(req, 'staff_document_added', { details: { staffId: String(s._id), psn: s.psn, documentId: String(d._id), title, confidential: d.confidential } });
  res.status(201).json({ document: serializeDoc(d, req.user) });
}));
async function loadDoc(req) {
  mustView(req);
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Document not found.');
  const d = await StaffDocument.findById(req.params.id);
  if (!d) throw new HttpError(404, 'Document not found.');
  return d;
}
router.get('/documents/:id/file', wrap(async (req, res) => {
  const d = await loadDoc(req);
  if (d.confidential && !canEdit(req.user)) throw new HttpError(403, 'This document is confidential.');
  const f = await fileStore.read(d.file);
  if (!f) throw new HttpError(404, 'The document file is missing.');
  await audit.log(req, 'staff_document_opened', { details: { staffId: String(d.staff), documentId: String(d._id), confidential: d.confidential } });
  res.set({ 'Content-Type': f.contentType, 'Content-Disposition': `inline; filename="${d.file.name}"`, 'Cache-Control': 'private, no-store' }).send(f.buffer);
}));
router.delete('/documents/:id', wrap(async (req, res) => {
  const d = await loadDoc(req);
  if (!serializeDoc(d, req.user).canDelete) throw new HttpError(403, 'The person who added a document can remove it the same day; after that, only an administrator.');
  await fileStore.remove(d.file);
  await d.deleteOne();
  await audit.log(req, 'staff_document_removed', { details: { staffId: String(d.staff), title: d.title } });
  res.json({ ok: true });
}));

// ── Import a roll from Excel or CSV: checked first, then saved ──
router.post('/import', sheetUpload, wrap(async (req, res) => {
  mustEdit(req);
  if (!req.file) throw new HttpError(400, 'Choose the Excel or CSV file of the roll.');
  if (req.body.commit === '1') {
    const r = await personnelImport.commit(req.file.buffer, req.file.originalname, req.user);
    await audit.log(req, 'nominal_roll_imported', { details: { file: req.file.originalname, added: r.added, failed: r.failed.length } });
    return res.json(r);
  }
  const a = await personnelImport.analyse(req.file.buffer, req.file.originalname);
  res.json({ ...a, rows: a.rows.map(({ doc, ...x }) => x) });
}));

module.exports = router;

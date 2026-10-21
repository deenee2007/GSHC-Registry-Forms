/*
 * src/routes/cases.js — the case file: every document that mentions a suit,
 * case or appeal number, across all units, oldest first.
 *
 * A document the user may open (their own unit, or one they made, submitted
 * or sign) is listed in full. One in another unit is listed by form, unit,
 * status and date only, so staff know it exists without seeing its
 * contents; drafts in other units are not listed at all.
 */
const express = require('express');
const { Record, Unit, Case, CaseDocument } = require('../models');
const { roman } = require('../services/process');
const catalogue = require('../forms/catalogue');
const { HttpError, requireLogin, canAccessUnit, can, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const same = (a, b) => String(a) === String(b);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_RECORDS = 500;
const MAX_CASES = 20;

function canOpen(user, rec) {
  if (isAdmin(user)) return true;
  if (same(rec.createdBy, user._id) || same(rec.submittedBy, user._id)) return true;
  if ((rec.slots || []).some(s => (s.approvers || []).some(a => same(a, user._id)))) return true;
  return canAccessUnit(user, rec.unitKey) && can(user, 'view');
}

router.get('/', wrap(async (req, res) => {
  const q = catalogue.normalizeCase(req.query.q);
  if (q.length < 3) throw new HttpError(400, 'Type at least 3 characters of the suit or case number.');
  const exact = req.query.exact === '1';
  const match = exact ? q : new RegExp(escapeRegex(q));
  const found = await Record.find({ caseNos: match })
    .select('unitKey formType status ref summary caseNos createdBy createdByName submittedBy slots.approvers createdAt submittedAt finalizedAt revokedAt')
    .sort({ createdAt: 1 }).limit(MAX_RECORDS + 1).lean();
  const units = Object.fromEntries((await Unit.find({}, 'key name').lean()).map(u => [u.key, u.name]));

  const cases = new Map();
  for (const r of found.slice(0, MAX_RECORDS)) {
    const open = canOpen(req.user, r);
    if (!open && ['draft', 'offline'].includes(r.status)) continue;
    const def = catalogue.get(r.formType);
    const item = {
      id: open ? String(r._id) : null, canOpen: open,
      formType: r.formType, formLabel: def ? def.label : r.formType,
      unitKey: r.unitKey, unitName: units[r.unitKey] || r.unitKey, status: r.status,
      date: r.finalizedAt || r.submittedAt || r.createdAt, createdAt: r.createdAt, finalizedAt: r.finalizedAt, revokedAt: r.revokedAt,
      summary: open ? r.summary : '', createdByName: open ? r.createdByName : ''
    };
    for (const caseNo of r.caseNos.filter(c => (exact ? c === q : c.includes(q)))) {
      if (!cases.has(caseNo)) cases.set(caseNo, []);
      cases.get(caseNo).push(item);
    }
  }
  // Registered cases from the Process Registry: filing, assignment, disposal.
  const regs = await Case.find({ caseNos: match, status: { $in: ['awaiting_assignment', 'assigned', 'dispatched', 'received', 'disposed'] } })
    .select('caseNos status firstParty secondParty registeredAt assignedAt assignedUnit disposal earlier').lean();
  // Scanned documents of those cases; opened by those who can see the case.
  const canSeeCase = require('./process').canSeeCase;
  const scans = await CaseDocument.find({ case: { $in: regs.map(c => c._id) } }).select('case title docType filedOn unitKey uploadedByName createdAt').lean();
  const courtNo = Object.fromEntries((await Unit.find({ type: 'registry' }, 'key courtNo').lean()).map(u => [u.key, u.courtNo]));
  for (const c of regs) {
    const label = c.status === 'awaiting_assignment' ? 'Case filed (awaiting assignment)'
      : c.status === 'disposed' ? `Case disposed: ${c.disposal ? c.disposal.remark : ''}`
      : c.earlier ? 'Case entered in the court register' : `Case assigned to High Court No. ${roman(courtNo[c.assignedUnit])}`;
    const item = {
      id: null, canOpen: false, formType: 'case', formLabel: label,
      unitKey: c.assignedUnit || 'process', unitName: c.assignedUnit ? (units[c.assignedUnit] || c.assignedUnit) : 'Process Registry',
      status: c.status === 'awaiting_assignment' ? 'pending' : 'final',
      date: (c.disposal && c.disposal.at) || c.assignedAt || c.registeredAt, createdAt: c.registeredAt,
      summary: `${c.firstParty} v. ${c.secondParty}`, createdByName: ''
    };
    for (const caseNo of (c.caseNos || []).filter(n => (exact ? n === q : n.includes(q)))) {
      if (!cases.has(caseNo)) cases.set(caseNo, []);
      cases.get(caseNo).unshift(item); // the filing comes first in its case
    }
    const open = canSeeCase(req.user, c);
    for (const d of scans.filter(x => same(x.case, c._id))) {
      const scan = {
        id: null, canOpen: false, fileUrl: open ? `/api/process/documents/${d._id}/file` : null,
        formType: 'scan', formLabel: `Scanned: ${d.title}${d.docType && d.docType !== d.title ? ` (${d.docType})` : ''}`,
        unitKey: d.unitKey, unitName: d.unitKey === 'process' ? 'Process Registry' : (units[d.unitKey] || d.unitKey), status: 'final',
        date: d.filedOn ? new Date(d.filedOn + 'T12:00:00Z') : d.createdAt, createdAt: d.createdAt,
        summary: `${c.firstParty} v. ${c.secondParty}`, createdByName: open ? d.uploadedByName : ''
      };
      for (const caseNo of (c.caseNos || []).filter(n => (exact ? n === q : n.includes(q)))) cases.get(caseNo).push(scan);
    }
  }

  // The number typed in full first, then the rest by how many documents they hold.
  const list = [...cases.entries()]
    .sort((a, b) => (b[0] === q) - (a[0] === q) || b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([caseNo, documents]) => ({
      caseNo, documents,
      parties: (documents.find(d => d.summary) || {}).summary || '',
      units: [...new Set(documents.map(d => d.unitName))]
    }));
  res.json({ query: q, cases: list.slice(0, MAX_CASES), moreCases: list.length > MAX_CASES, truncated: found.length > MAX_RECORDS });
}));

// ── Fill a new form from earlier documents for the same case ──
// Boxes that hold the same thing on every document of a case (parties,
// addresses, court, offence) are offered; boxes that differ per document
// (dates, times, fees, amounts, references, who was served) never are.
const NOT_COPIED = /date|time|fee|mileage|amount|levied|^ourref$|^refno|writno|noticedays|personnelcount|^served|deliveredto|unknownperson|pointedoutby|askedidentity|identityresponse|^recipient|receiptnumber|sum(naira|kobo)$|^execution|additionalgrounds/i;
// The first and second party go by different names on different forms.
const ALIASES = [['plaintiff', 'complainant', 'plaintiffName'], ['defendant']];

function prefillValues(def, sources) {
  const values = {};
  const used = new Set();
  for (const f of def.schema) {
    if (!f.name || f.type === 'date' || f.type === 'table' || NOT_COPIED.test(f.name) || catalogue.CASE_FIELDS.includes(f.name)) continue;
    const names = [f.name, ...((ALIASES.find(g => g.includes(f.name)) || []).filter(n => n !== f.name))];
    for (const r of sources) {
      const name = names.find(n => typeof r.data[n] === 'string' && r.data[n].trim());
      if (!name) continue;
      const v = r.data[name].trim();
      if (f.type === 'select' && !(f.options || []).some(o => (o.value !== undefined ? o.value : o) === v)) continue;
      values[f.name] = v;
      used.add(String(r._id));
      break;
    }
  }
  return { values, used };
}

router.get('/prefill', wrap(async (req, res) => {
  const caseNo = catalogue.normalizeCase(req.query.caseNo);
  const def = catalogue.get(String(req.query.formType || ''));
  if (!def) throw new HttpError(400, 'Unknown form.');
  if (caseNo.length < 3) return res.json({ caseNo, values: {}, sources: [] });
  const found = await Record.find({ caseNos: caseNo, status: { $ne: 'offline' } })
    .select('unitKey formType status data createdBy submittedBy slots.approvers createdAt updatedAt')
    .sort({ updatedAt: -1 }).limit(50).lean();
  const mine = found.filter(r => canOpen(req.user, r)).slice(0, 20); // newest first: the latest value wins
  const { values, used } = prefillValues(def, mine);
  const sources = mine.filter(r => used.has(String(r._id))).map(r => {
    const d = catalogue.get(r.formType);
    return { formLabel: d ? d.label : r.formType, date: r.updatedAt };
  });
  res.json({ caseNo, values, sources });
}));

module.exports = router;

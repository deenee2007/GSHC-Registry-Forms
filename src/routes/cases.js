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
const { Record, Unit } = require('../models');
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

module.exports = router;

/*
 * src/routes/hearings.js — upcoming court dates for the Home page: the
 * user's own courts and units, or every unit for an administrator.
 */
const express = require('express');
const hearings = require('../services/hearings');
const { HttpError, requireLogin, isAdmin, can } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

router.get('/', wrap(async (req, res) => {
  const u = req.user;
  let unitKeys = null;
  if (!isAdmin(u)) {
    if (!u.unitKeys.length || !(can(u, 'view') || u.signerRoles.length)) return res.json({ from: '', to: '', hearings: [] });
    unitKeys = u.unitKeys;
  }
  const today = new Date();
  const from = DAY.test(req.query.from || '') ? req.query.from : hearings.iso(today);
  const days = Math.min(62, Math.max(1, parseInt(req.query.days, 10) || 14));
  const end = new Date(from + 'T00:00:00'); end.setDate(end.getDate() + days - 1);
  const to = hearings.iso(end);
  if (req.query.unitKey) {
    if (unitKeys && !unitKeys.includes(String(req.query.unitKey))) throw new HttpError(403, 'You do not have access to this unit.');
    unitKeys = [String(req.query.unitKey)];
  }
  res.json({ from, to, hearings: await hearings.list({ from, to, unitKeys }) });
}));

module.exports = router;

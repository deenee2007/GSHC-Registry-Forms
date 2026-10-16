/*
 * src/routes/catalogue.js — units and forms the signed in user can use,
 * with each form's signing rule.
 */
const express = require('express');
const { Unit, FormConfig, User } = require('../models');
const catalogue = require('../forms/catalogue');
const { SIGNER_ROLES } = require('../forms/signers');
const { requireLogin, canAccessUnit, HttpError } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

router.get('/units', wrap(async (req, res) => {
  const units = await Unit.find({ active: true }).sort({ type: 1, courtNo: 1, name: 1 });
  const visible = units.filter(u => canAccessUnit(req.user, u.key));
  res.json({ units: visible.map(u => ({ key: u.key, type: u.type, name: u.name, courtNo: u.courtNo, allowedForms: u.allowedForms, forms: catalogue.formsForUnit(u) })) });
}));

router.get('/forms', wrap(async (req, res) => {
  const configs = Object.fromEntries((await FormConfig.find()).map(c => [c.formType, c.signers]));
  const forms = Object.entries(catalogue.forms).map(([formType, def]) => ({
    formType, label: def.label, unitType: def.unitType, signers: configs[formType] || []
  }));
  res.json({ forms, signerRoles: SIGNER_ROLES });
}));

// People who can sign a given line on a record of a given unit; used to
// pick approvers when submitting (one judge per court, or a panel).
router.get('/signers', wrap(async (req, res) => {
  const role = String(req.query.role || '');
  const unitKey = String(req.query.unitKey || '');
  if (!SIGNER_ROLES[role]) throw new HttpError(400, 'Invalid signing role.');
  const users = await User.find({ active: true, signerRoles: role });
  const eligible = users.filter(u => !u.unitKeys.length || u.unitKeys.includes(unitKey));
  res.json({
    signers: eligible.map(u => ({ id: String(u._id), fullName: u.fullName, title: u.title, unitKeys: u.unitKeys, ready: !!(u.signature && u.signingPinHash) }))
  });
}));

module.exports = router;

/*
 * src/routes/mystaff.js — an officer's own record, from their personal
 * staff account: to read, not to change (corrections go through the
 * Directorate of Personnel). Confidential documents are not shown.
 */
const express = require('express');
const { HttpError, requireLogin } = require('../middleware/auth');
const personnel = require('../services/personnel');
const account = require('../services/personalAccount');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const years = (from) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) return null;
  const a = new Date(from + 'T12:00:00Z'), b = new Date();
  let y = b.getUTCFullYear() - a.getUTCFullYear();
  if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) y--;
  return y;
};

router.get('/', wrap(async (req, res) => {
  const s = await account.ownStaff(req.user);
  if (!s) throw new HttpError(404, 'This account is not linked to a record on the Nominal Roll.');
  res.json({ staff: {
    psn: s.psn, name: s.name, title: s.title || '', sex: s.sex, rank: s.rank, cadre: s.cadre, gl: s.gl, step: s.step,
    qualification: s.qualification, qualifications: s.qualifications || [], dob: s.dob, dofa: s.dofa, dopa: s.dopa, confirmedOn: s.confirmedOn,
    lga: s.lga, station: s.station, contract: !!s.contract, contractEnds: s.contractEnds, phone: s.phone, email: s.email, address: s.address,
    nextOfKin: s.nextOfKin || {}, status: s.status, statusLabel: personnel.STATUS_LABELS[s.status] || s.status,
    retiresOn: s.retiresOn, retiresBy: s.retiresBy, age: years(s.dob), service: years(s.dofa),
    history: [...(s.history || [])].filter(h => h.kind !== 'account').reverse().map(h => ({ kind: h.kind, date: h.date, text: h.text }))
  } });
}));

module.exports = router;

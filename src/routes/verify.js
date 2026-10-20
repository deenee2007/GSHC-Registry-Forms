/*
 * src/routes/verify.js — the public check behind every QR code. No sign in
 * needed. It confirms a document is genuine without exposing its contents.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { Record, Unit, Case } = require('../models');
const { roman } = require('../services/process');
const catalogue = require('../forms/catalogue');
const verification = require('../services/verification');

const router = express.Router();

router.use(rateLimit({
  windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { status: 'error', error: 'Too many checks from this address. Please wait a few minutes.' }
}));

router.get('/:code', async (req, res, next) => {
  try {
    const code = verification.normaliseCode(req.params.code);
    const rec = code ? await Record.findOne({ verifyCode: code, status: { $in: ['final', 'revoked'] } }) : null;
    if (!rec) {
      // A case assignment slip from the Process Registry.
      const c = code ? await Case.findOne({ verifyCode: code, assignment: { $ne: null } }) : null;
      if (!c) return res.status(404).json({ status: 'not_found', code: code || String(req.params.code).slice(0, 40) });
      const court = await Unit.findOne({ key: c.assignedUnit });
      return res.json({
        status: verification.hashCase(c) === c.contentHash ? 'valid' : 'tampered',
        code: c.verifyCode,
        document: `Case Assignment: High Court No. ${roman(court && court.courtNo)}`,
        reference: c.suitNumber || null,
        court: court ? court.name : c.assignedUnit,
        issuedAt: c.assignedAt,
        signedBy: [{ capacity: 'Hon. Chief Judge', name: c.assignment.name, title: c.assignment.title || null, signedAt: c.assignment.signedAt }]
      });
    }

    const intact = verification.hashRecord(rec) === rec.contentHash;
    const unit = await Unit.findOne({ key: rec.unitKey });
    const def = catalogue.get(rec.formType);
    res.json({
      status: !intact ? 'tampered' : rec.status === 'revoked' ? 'revoked' : 'valid',
      code: rec.verifyCode,
      document: def ? def.label : rec.formType,
      reference: rec.ref || null,
      court: unit ? unit.name : rec.unitKey,
      issuedAt: rec.finalizedAt,
      signedBy: rec.slots.flatMap(s => s.signatures.map(g => ({ capacity: s.label, name: g.name, title: g.title || null, signedAt: g.signedAt }))),
      revokedAt: rec.status === 'revoked' ? rec.revokedAt : undefined,
      revokeReason: rec.status === 'revoked' ? rec.revokeReason : undefined
    });
  } catch (e) { next(e); }
});

module.exports = router;

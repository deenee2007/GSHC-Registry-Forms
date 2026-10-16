/*
 * src/routes/me.js — a signer's own signature image and signing PIN.
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const pw = require('../services/passwords');
const store = require('../services/signatureStore');
const audit = require('../services/audit');
const { HttpError, requireLogin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

router.use(requireLogin);

function requireSigner(req, res, next) {
  if (!req.user.signerRoles.length) return next(new HttpError(403, 'Only users with a signing role can register a signature.'));
  next();
}

// Upload a scanned signature (multipart field "file") or a signature drawn
// on screen (JSON { dataUrl }). The current password is required.
router.post('/signature', requireSigner, upload.single('file'), wrap(async (req, res) => {
  if (!(await pw.compare(req.body.password, req.user.passwordHash))) throw new HttpError(400, 'Password is incorrect.');
  const buffer = req.file ? req.file.buffer : store.fromDataUrl(req.body.dataUrl);
  const ref = await store.save(buffer, String(req.user._id));
  req.user.signature = ref;
  req.user.signatureUpdatedAt = new Date();
  await req.user.save();
  await audit.log(req, 'signature_registered', { details: { provider: ref.provider } });
  res.json({ user: req.user.toSafeJSON() });
}));

router.get('/signature', requireSigner, wrap(async (req, res) => {
  const img = await store.read(req.user.signature);
  if (!img) throw new HttpError(404, 'No signature registered yet.');
  res.set('Content-Type', img.contentType).set('Cache-Control', 'private, no-store').send(img.buffer);
}));

router.post('/signing-pin', requireSigner, wrap(async (req, res) => {
  const { password, pin } = req.body;
  if (!(await pw.compare(password, req.user.passwordHash))) throw new HttpError(400, 'Password is incorrect.');
  const problem = pw.checkPin(pin);
  if (problem) throw new HttpError(400, problem);
  req.user.signingPinHash = await pw.hash(pin);
  req.user.pinFailures = 0; req.user.pinLockedUntil = null;
  await req.user.save();
  await audit.log(req, 'signing_pin_set');
  res.json({ user: req.user.toSafeJSON() });
}));

// The user's own choices, e.g. { emailAlerts: false }. Open to every user,
// signer or not.
router.patch('/preferences', wrap(async (req, res) => {
  if (req.body.emailAlerts !== undefined) req.user.emailAlerts = !!req.body.emailAlerts;
  await req.user.save();
  await audit.log(req, 'preferences_updated', { details: { emailAlerts: req.user.emailAlerts } });
  res.json({ user: req.user.toSafeJSON() });
}));

// Used by the workflow before any signature is placed.
async function verifyPin(user, pin) {
  if (!user.signingPinHash) throw new HttpError(400, 'Set your signing PIN first (My Signature).');
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    throw new HttpError(429, 'Signing is locked after repeated wrong PINs. Try again later.');
  }
  if (!(await pw.compare(pin, user.signingPinHash))) {
    user.pinFailures += 1;
    if (user.pinFailures >= config.pinMaxAttempts) {
      user.pinLockedUntil = new Date(Date.now() + config.pinLockMinutes * 60000);
      user.pinFailures = 0;
    }
    await user.save();
    throw new HttpError(400, 'Signing PIN is incorrect.');
  }
  if (user.pinFailures) { user.pinFailures = 0; await user.save(); }
}

module.exports = router;
module.exports.verifyPin = verifyPin;

/*
 * src/routes/auth.js — sign in, sign out, change password, current user.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { User, PasswordToken } = require('../models');
const pw = require('../services/passwords');
const mail = require('../services/mail');
const links = require('../services/passwordLinks');
const audit = require('../services/audit');
const { HttpError, requireLogin, allowTempPassword } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many sign in attempts. Please wait a few minutes and try again.' }
});

// One message for every failure, so the screen never reveals which
// usernames exist.
const BAD_LOGIN = 'Invalid username or password.';

// Checked against when the username does not exist, so a wrong username
// takes as long to reject as a wrong password.
let _dummy = null;
const dummyHash = async () => (_dummy = _dummy || await pw.hash('not-a-real-password'));

router.post('/login', loginLimiter, wrap(async (req, res) => {
  // Email address or username; staff now sign in with their email.
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = username ? (await User.findOne({ username }) || await User.findOne({ email: username })) : null;

  if (!user || !user.active) {
    await pw.compare(password, await dummyHash()); // even out timing
    throw new HttpError(401, BAD_LOGIN);
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new HttpError(429, 'This account is temporarily locked after repeated failed sign ins. Try again later.');
  }
  if (!(await pw.compare(password, user.passwordHash))) {
    user.failedLogins += 1;
    if (user.failedLogins >= config.loginMaxAttempts) {
      user.lockedUntil = new Date(Date.now() + config.loginLockMinutes * 60000);
      user.failedLogins = 0;
    }
    await user.save();
    await audit.log({ ip: req.ip }, 'login_failed', { details: { username } });
    throw new HttpError(401, BAD_LOGIN);
  }

  user.failedLogins = 0; user.lockedUntil = null; user.lastLoginAt = new Date();
  await user.save();
  await new Promise((resolve, reject) => req.session.regenerate(e => (e ? reject(e) : resolve())));
  req.session.userId = String(user._id);
  req.user = user;
  await audit.log(req, 'login');
  res.json({ user: user.toSafeJSON() });
}));

router.post('/logout', wrap(async (req, res) => {
  if (req.user) await audit.log(req, 'logout');
  await new Promise(resolve => req.session.destroy(() => resolve()));
  res.clearCookie('gshc.sid');
  res.json({ ok: true });
}));

router.get('/me', allowTempPassword, requireLogin, (req, res) => res.json({ user: req.user.toSafeJSON() }));

router.post('/change-password', allowTempPassword, requireLogin, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await pw.compare(currentPassword, req.user.passwordHash))) throw new HttpError(400, 'Current password is incorrect.');
  const problem = pw.checkPassword(newPassword);
  if (problem) throw new HttpError(400, problem);
  if (await pw.compare(newPassword, req.user.passwordHash)) throw new HttpError(400, 'Choose a password different from the current one.');
  req.user.passwordHash = await pw.hash(newPassword);
  req.user.mustChangePassword = false;
  await req.user.save();
  await links.endSessions(req.user._id, req.sessionID); // sign out other browsers
  await audit.log(req, 'password_changed');
  res.json({ user: req.user.toSafeJSON() });
}));

// What the sign in screen may offer (no sign in needed).
router.get('/options', (req, res) => res.json({ forgotPassword: mail.enabled() }));

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many reset requests. Please wait a few minutes and try again.' }
});

// The answer is the same whether or not an account matched, so this cannot
// be used to find out which usernames or emails exist.
const FORGOT_REPLY = 'If an account with an email address matches, a reset link has been sent to it. The link expires in ' +
  `${config.resetMinutes} minutes. If no email arrives, ask the administrator to reset your password.`;

router.post('/forgot', forgotLimiter, wrap(async (req, res) => {
  if (!mail.enabled()) throw new HttpError(503, 'Password reset by email is not available. Ask the administrator to reset your password.');
  const who = String(req.body.username || '').trim().toLowerCase();
  if (!who) throw new HttpError(400, 'Enter your username or email address.');
  const user = await User.findOne(who.includes('@') ? { email: who } : { username: who });
  if (user && user.active && user.email) {
    try {
      await links.sendLink(req, user, 'reset');
      await audit.log({ ip: req.ip }, 'password_reset_requested', { details: { username: user.username } });
    } catch (e) { console.error('Reset email failed:', e.message); }
  }
  res.json({ message: FORGOT_REPLY });
}));

// Check a link before showing the "choose a password" screen.
router.get('/reset/:token', wrap(async (req, res) => {
  const rec = await links.findValid(req.params.token);
  if (!rec) return res.json({ valid: false });
  res.json({ valid: true, kind: rec.kind, username: rec.user.username, fullName: rec.user.fullName });
}));

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

router.post('/reset', resetLimiter, wrap(async (req, res) => {
  const rec = await links.findValid(req.body.token);
  if (!rec) throw new HttpError(400, 'This link has expired or has already been used. Ask for a new one.');
  const problem = pw.checkPassword(req.body.newPassword);
  if (problem) throw new HttpError(400, problem);
  const user = await User.findById(rec.user._id);
  user.passwordHash = await pw.hash(req.body.newPassword);
  user.mustChangePassword = false; user.failedLogins = 0; user.lockedUntil = null;
  await user.save();
  rec.usedAt = new Date();
  await rec.save();
  await PasswordToken.deleteMany({ user: user._id, usedAt: null });
  await links.endSessions(user._id);
  await audit.log({ ip: req.ip, user }, rec.kind === 'invite' ? 'invite_accepted' : 'password_reset_completed', { details: { username: user.username } });
  res.json({ ok: true, username: user.username });
}));

module.exports = router;

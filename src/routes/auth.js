/*
 * src/routes/auth.js — sign in, sign out, change password, current user.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { User } = require('../models');
const pw = require('../services/passwords');
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
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = username ? await User.findOne({ username }) : null;

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
  await audit.log(req, 'password_changed');
  res.json({ user: req.user.toSafeJSON() });
}));

module.exports = router;

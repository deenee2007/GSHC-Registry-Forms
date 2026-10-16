/*
 * src/services/passwordLinks.js — one time links for choosing a password
 * (invitations for new accounts and password resets), and signing a user
 * out everywhere after their password changes.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const { PasswordToken } = require('../models');
const mail = require('./mail');
const verification = require('./verification');

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Issue a link and email it. Any earlier unused link for the user stops working.
async function sendLink(req, user, kind) {
  if (!user.email) throw Object.assign(new Error('This user has no email address.'), { status: 400 });
  await PasswordToken.deleteMany({ user: user._id, usedAt: null });
  const token = crypto.randomBytes(32).toString('base64url');
  const ms = kind === 'invite' ? config.inviteHours * 3600000 : config.resetMinutes * 60000;
  await PasswordToken.create({ user: user._id, kind, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ms) });
  const link = `${verification.baseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
  const msg = kind === 'invite'
    ? mail.inviteMessage(user, link, config.inviteHours)
    : mail.resetMessage(user, link, config.resetMinutes);
  await mail.send({ to: user.email, name: user.fullName, ...msg });
}

// The token record if the link is still good, otherwise null.
async function findValid(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const rec = await PasswordToken.findOne({ tokenHash: hashToken(token) }).populate('user');
  if (!rec || rec.usedAt || rec.expiresAt < new Date() || !rec.user || !rec.user.active) return null;
  return rec;
}

// Remove the user's sessions (except, optionally, the current one), so a
// changed password signs out every other browser.
async function endSessions(userId, exceptSessionId) {
  const sessions = mongoose.connection.collection('sessions');
  const q = { session: { $regex: `"userId":"${String(userId)}"` } };
  if (exceptSessionId) q._id = { $ne: exceptSessionId };
  await sessions.deleteMany(q);
}

module.exports = { sendLink, findValid, endSessions };

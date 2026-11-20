/*
 * src/services/personalAccount.js — an officer's personal staff account.
 *
 * Every officer on the Nominal Roll may have one, made from their record
 * by the Director Personnel or the administrator, only for those who need
 * it (the rest stay without). The PSN is the sign in name. The officer
 * gets a printed slip with a one time activation code (and, if an email is
 * given, a link to choose a password); at the first sign in they choose
 * their own password. The account reaches only their own matters: their
 * record, leave, and later appraisal and the like. It is separate from any
 * work account they use for a unit's work.
 */
const { User, Staff } = require('../models');
const pw = require('./passwords');
const mail = require('./mail');
const links = require('./passwordLinks');

const bad = (status, message) => Object.assign(new Error(message), { status });
const username = (staff) => String(staff.psn || '').trim().toLowerCase();
// Readable on a slip: groups of four, without letters easily misread.
function activationCode() {
  const s = pw.temporaryPassword().toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const cleanEmail = (v) => {
  const e = String(v || '').trim().toLowerCase();
  if (!e) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad(400, 'Enter a valid email address, or leave it empty.');
  return e;
};

// Who may make and manage personal accounts.
const mayManage = (u) => u.role === 'admin' || (u.signerRoles || []).includes('director_personnel');

async function emailTaken(email, exceptId) {
  return email && await User.exists({ email, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
}

// What the record shows of the account.
async function describe(staff) {
  if (!staff.user) return { status: 'none', username: username(staff) };
  const u = await User.findById(staff.user).lean();
  if (!u) return { status: 'none', username: username(staff) };
  return { status: u.active ? 'active' : 'inactive', username: u.username, email: u.email || '', lastLoginAt: u.lastLoginAt || null,
    firstSignIn: !!u.mustChangePassword, activatedBy: staff.accountActivatedBy || '', activatedAt: staff.accountActivatedAt || null };
}

async function sendLinkIfEmail(req, user) {
  if (!user.email || !mail.enabled()) return false;
  try { await links.sendLink(req, user, 'invite'); return true; } catch (e) { return false; }
}

async function activate(req, staff, { email }) {
  if (['retired', 'resigned', 'deceased', 'transferred_out', 'dismissed'].includes(staff.status)) throw bad(409, `${staff.name} is no longer in service, so no account is made.`);
  const name = username(staff);
  if (!name) throw bad(400, 'The record has no PSN.');
  let user = staff.user ? await User.findById(staff.user) : null;
  if (user && user.active) throw bad(409, `${staff.name} already has an active account (${user.username}). Use New Code if they cannot sign in.`);
  const mailTo = cleanEmail(email !== undefined ? email : staff.email);
  if (await emailTaken(mailTo, user && user._id)) throw bad(409, `${mailTo} is already used by another account. Leave the email empty, or give another.`);
  const code = activationCode();
  if (user) {
    // Reactivated: a new code; the account and its history stay.
    Object.assign(user, { active: true, passwordHash: await pw.hash(code), mustChangePassword: true, failedLogins: 0, lockedUntil: null });
    if (mailTo) user.email = mailTo;
  } else {
    const clash = await User.findOne({ username: name });
    if (clash) throw bad(409, `The sign in name ${name} is already used by another account (${clash.fullName}). Ask the administrator to rename that account.`);
    user = new User({ username: name, kind: 'personal', fullName: staff.name, title: staff.title || '', email: mailTo || undefined,
      passwordHash: await pw.hash(code), mustChangePassword: true, role: 'user', unitKeys: [], privileges: [], signerRoles: [] });
  }
  await user.save();
  staff.user = user._id;
  staff.accountActivatedBy = req.user.fullName;
  staff.accountActivatedAt = new Date();
  await staff.save();
  return { user, code, emailed: await sendLinkIfEmail(req, user) };
}

// A new code, for an officer who cannot sign in (forgotten password, slip lost).
async function newCode(req, staff) {
  const user = staff.user ? await User.findById(staff.user) : null;
  if (!user || !user.active) throw bad(409, `${staff.name} has no active account. Activate it first.`);
  const code = activationCode();
  Object.assign(user, { passwordHash: await pw.hash(code), mustChangePassword: true, failedLogins: 0, lockedUntil: null });
  await user.save();
  await links.endSessions(user._id);
  return { user, code, emailed: await sendLinkIfEmail(req, user) };
}

async function deactivate(staff) {
  const user = staff.user ? await User.findById(staff.user) : null;
  if (!user || !user.active) throw bad(409, `${staff.name} has no active account.`);
  user.active = false;
  await user.save();
  await links.endSessions(user._id);
  return user;
}

// The officer's own record, from their personal account.
const ownStaff = (u) => (u.kind === 'personal' ? Staff.findOne({ user: u._id }) : null);

module.exports = { activate, newCode, deactivate, describe, mayManage, ownStaff, activationCode };

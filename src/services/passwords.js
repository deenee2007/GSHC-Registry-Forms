/*
 * src/services/passwords.js — password and signing PIN rules.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROUNDS = 12;

function checkPassword(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain both letters and numbers.';
  if (pw.length > 128) return 'Password is too long.';
  return null;
}

function checkPin(pin) {
  return /^\d{4,8}$/.test(String(pin || '')) ? null : 'Signing PIN must be 4 to 8 digits.';
}

// A one time password an admin hands to a new user; they must change it.
function temporaryPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 8; i++) s += letters[b[i] % letters.length];
  return s + String(10 + (b[8] % 90));
}

const hash = (s) => bcrypt.hash(String(s), ROUNDS);
const compare = (s, h) => (h ? bcrypt.compare(String(s || ''), h) : Promise.resolve(false));

module.exports = { checkPassword, checkPin, temporaryPassword, hash, compare };

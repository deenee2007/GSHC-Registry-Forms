/*
 * src/services/settings.js — system wide switches an administrator can
 * change in Settings (kept in MongoDB, not in environment variables).
 */
const mongoose = require('mongoose');

const DEFAULTS = { emailAlerts: true };
const KEY = 'settings';

const col = () => mongoose.connection.collection('appmeta');

async function get() {
  const doc = await col().findOne({ _id: KEY });
  const out = { ...DEFAULTS };
  if (doc) Object.keys(DEFAULTS).forEach(k => { if (doc[k] !== undefined) out[k] = doc[k]; });
  return out;
}

async function set(changes) {
  const clean = {};
  if (changes.emailAlerts !== undefined) clean.emailAlerts = !!changes.emailAlerts;
  if (Object.keys(clean).length) await col().updateOne({ _id: KEY }, { $set: clean }, { upsert: true });
  return get();
}

module.exports = { get, set, DEFAULTS };

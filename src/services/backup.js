/*
 * src/services/backup.js — the automatic daily backup.
 *
 * Once a day the server writes one compressed file holding the units,
 * users, signing rules, records, notifications, settings and audit log
 * (dates and ids kept exactly, as MongoDB Extended JSON), and copies every
 * saved copy of a signed document that has not been copied yet, one file
 * each (they never change). Data files older than BACKUP_KEEP_DAYS are
 * removed; the newest is always kept. scripts/restore-backup.js puts a
 * backup back into an empty database.
 */
const zlib = require('zlib');
const mongoose = require('mongoose');
const { BSON } = require('mongodb');
const config = require('../config');
const storeFactory = require('./backupStore');
const mail = require('./mail');
const { Backup, DocumentCopy, User } = require('../models');

const COLLECTIONS = ['units', 'users', 'formconfigs', 'records', 'cases', 'notifications', 'auditlogs', 'appmeta'];
const SKIP_META = ['backupLock', 'backupAlert']; // working state, not data
const DAY = 24 * 60 * 60 * 1000;
const LOCK_MINUTES = 30;

let store; // opened on first use, so tests can set the environment first
const getStore = () => (store === undefined ? (store = storeFactory.open()) : store);

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `_${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// Only one backup at a time, even across several server instances.
async function lock() {
  const meta = mongoose.connection.collection('appmeta');
  const now = new Date();
  try {
    await meta.findOneAndUpdate(
      { _id: 'backupLock', $or: [{ until: { $lt: now } }, { until: { $exists: false } }] },
      { $set: { until: new Date(now.getTime() + LOCK_MINUTES * 60000) } }, { upsert: true });
    return true;
  } catch (e) {
    if (e.code === 11000) return false; // held by a run in progress
    throw e;
  }
}
const unlock = () => mongoose.connection.collection('appmeta').deleteOne({ _id: 'backupLock' });

async function dataFile(at) {
  const db = mongoose.connection.db;
  const collections = {};
  const counts = {};
  for (const name of COLLECTIONS) {
    const filter = name === 'appmeta' ? { _id: { $nin: SKIP_META } } : {};
    collections[name] = await db.collection(name).find(filter).toArray();
    counts[name] = collections[name].length;
  }
  const json = BSON.EJSON.stringify({ app: 'gshc-registry', format: 1, createdAt: at, database: mongoose.connection.name, collections }, { relaxed: false });
  return { buffer: zlib.gzipSync(json), counts };
}

// Saved copies not yet in the store.
async function copyNewCopies(s) {
  let added = 0;
  for await (const c of DocumentCopy.find({ backedUpAt: { $exists: false } }).cursor()) {
    await s.put(`copies/${c.record}.html.gz`, zlib.gzipSync(c.html));
    await DocumentCopy.updateOne({ _id: c._id }, { $set: { backedUpAt: new Date() } });
    added++;
  }
  return added;
}

// Remove data files past the keeping period, never the newest one.
async function prune(s, now) {
  const cutoff = new Date(now.getTime() - config.backupKeepDays * DAY);
  const newest = await Backup.findOne({ ok: true, deleted: false }).sort({ at: -1 });
  const old = await Backup.find({ ok: true, deleted: false, at: { $lt: cutoff }, _id: { $ne: newest && newest._id }, file: { $ne: newest && newest.file } });
  for (const b of old) {
    try { await s.remove(b.file); await Backup.updateOne({ _id: b._id }, { $set: { deleted: true } }); }
    catch (e) { console.error(`Could not remove old backup ${b.file}: ${e.message}`); }
  }
  await Backup.deleteMany({ ok: false, at: { $lt: cutoff } });
}

// Email the administrators, at most once a day.
async function alertAdmins(error) {
  if (!mail.enabled()) return;
  const meta = mongoose.connection.collection('appmeta');
  const last = await meta.findOne({ _id: 'backupAlert' });
  if (last && Date.now() - last.at < DAY) return;
  await meta.updateOne({ _id: 'backupAlert' }, { $set: { at: new Date() } }, { upsert: true });
  const admins = await User.find({ role: 'admin', active: true, email: { $type: 'string' } });
  const link = config.publicBaseUrl ? config.publicBaseUrl + '/' : '';
  await Promise.allSettled(admins.map(u => mail.send({ to: u.email, name: u.fullName, ...mail.backupFailedMessage(u, error, link) })
    .catch(e => console.error(`Backup alert to ${u.username} failed: ${e.message}`))));
}

/**
 * Run one backup now. Resolves to the Backup entry, or throws with status
 * 503 (no store) or 409 (another backup is running).
 */
async function run({ reason = 'scheduled', by } = {}) {
  const s = getStore();
  if (!s) throw Object.assign(new Error('Backups need Cloudinary. Set CLOUDINARY_URL on the server.'), { status: 503 });
  if (!(await lock())) throw Object.assign(new Error('A backup is already running. Try again in a few minutes.'), { status: 409 });
  const at = new Date();
  try {
    const { buffer, counts } = await dataFile(at);
    const file = `data/gshc_${stamp(at)}.json.gz`;
    await s.put(file, buffer);
    const copiesAdded = await copyNewCopies(s);
    const entry = await Backup.create({ at, ok: true, reason, by, file, bytes: buffer.length, counts, copiesAdded });
    await prune(s, at);
    console.log(`Backup saved: ${file} (${Math.round(buffer.length / 1024)} KB, ${counts.records} records, ${copiesAdded} new signed copies).`);
    return entry;
  } catch (e) {
    console.error(`Backup failed: ${e.message}`);
    const entry = await Backup.create({ at, ok: false, reason, by, error: e.message.slice(0, 500) });
    await alertAdmins(e.message).catch(err => console.error('Backup alert failed:', err.message));
    if (reason === 'manual') throw Object.assign(new Error(`The backup failed: ${e.message}`), { status: 502, entry });
    return entry;
  } finally {
    await unlock();
  }
}

// Due when the last good backup is about a day old (or there is none).
async function due(now = new Date()) {
  const last = await Backup.findOne({ ok: true }).sort({ at: -1 });
  return !last || now - last.at >= DAY - 10 * 60000;
}

async function tick() {
  try { if (await due()) await run({ reason: 'scheduled' }); }
  catch (e) { if (e.status !== 409) console.error(`Backup check failed: ${e.message}`); }
}

// Checked every hour, so a server that slept through the usual time (the
// free Render plan sleeps when idle) catches up soon after it wakes.
let timers = [];
function start(log = console.log) {
  if (!config.backupEnabled) { log('  Backups: switched off (BACKUP_ENABLED).'); return; }
  const s = getStore();
  if (!s) { log('  Backups: OFF. Set CLOUDINARY_URL to keep a daily backup.'); return; }
  log(`  Backups: daily, kept ${config.backupKeepDays} days, in ${s.where}.`);
  timers = [setTimeout(tick, 2 * 60000), setInterval(tick, 60 * 60000)];
  timers.forEach(t => t.unref());
}
function stop() { timers.forEach(t => clearTimeout(t)); timers = []; }

async function read(entry) {
  const s = getStore();
  if (!s) throw Object.assign(new Error('Backups need Cloudinary. Set CLOUDINARY_URL on the server.'), { status: 503 });
  return s.get(entry.file);
}

const status = () => { const s = getStore(); return { enabled: !!s && config.backupEnabled, where: s ? s.where : '', keepDays: config.backupKeepDays }; };

module.exports = { run, due, tick, start, stop, read, status, COLLECTIONS, _reset: () => { store = undefined; } };

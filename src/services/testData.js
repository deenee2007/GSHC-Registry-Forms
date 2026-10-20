/*
 * src/services/testData.js — clearing the documents made while testing,
 * once, just before the system goes into full use.
 *
 * It deletes every form, saved copy and notification, and the audit
 * entries about those forms (so Reports start from zero), after a backup
 * has been made of everything. Users, units, signing rules, signatures and
 * PINs stay. It works once only: afterwards it is refused, so it can never
 * be used on real court records.
 */
const mongoose = require('mongoose');
const backup = require('./backup');
const { Record, DocumentCopy, Notification, AuditLog, Case } = require('../models');

const CONFIRM = 'CLEAR TEST DATA';
const KEY = 'testDataCleared';
const meta = () => mongoose.connection.collection('appmeta');

async function counts() {
  const [records, signed, copies, notifications, cases] = await Promise.all([
    Record.countDocuments(), Record.countDocuments({ status: { $in: ['final', 'revoked'] } }),
    DocumentCopy.countDocuments(), Notification.countDocuments(), Case.countDocuments()
  ]);
  return { records, signed, copies, notifications, cases };
}

async function status() {
  const done = await meta().findOne({ _id: KEY });
  return done ? { available: false, done: { at: done.at, by: done.by, counts: done.counts } } : { available: true, counts: await counts() };
}

/** Clear the test documents. Throws with .status 400 (wrong word), 409 (done already) or 503 (no backup). */
async function clear({ confirm, by }) {
  if (String(confirm || '').trim().toUpperCase() !== CONFIRM) {
    throw Object.assign(new Error(`Type ${CONFIRM} to confirm.`), { status: 400 });
  }
  if (await meta().findOne({ _id: KEY })) {
    throw Object.assign(new Error('The test data was already cleared. This can only be done once.'), { status: 409 });
  }
  // A backup first, so nothing is truly lost; no backup, no clearing.
  let saved;
  try { saved = await backup.run({ reason: 'manual', by }); }
  catch (e) { throw Object.assign(new Error(`Nothing was cleared, because the backup first failed: ${e.message}`), { status: e.status === 409 ? 409 : 503 }); }

  const before = await counts();
  // Claimed before deleting, so two administrators cannot both run it.
  try { await meta().insertOne({ _id: KEY, at: new Date(), by, counts: before, backupFile: saved.file }); }
  catch (e) {
    if (e.code === 11000) throw Object.assign(new Error('The test data was already cleared.'), { status: 409 });
    throw e;
  }

  await Promise.all([
    Record.deleteMany({}), DocumentCopy.deleteMany({}), Notification.deleteMany({}),
    AuditLog.deleteMany({ record: { $exists: true } }),
    AuditLog.deleteMany({ action: /^case_/ }),
    // Process Registry test cases: suit numbers start again at 1, and the
    // court rotation starts again from High Court 1.
    Case.deleteMany({}),
    meta().deleteMany({ _id: { $in: [/^hearingDigest:/, /^caseSeq:/, /^invoiceSeq:/, /^rotation:/] } })
  ]);
  return { counts: before, backupFile: saved.file };
}

module.exports = { status, clear, CONFIRM };

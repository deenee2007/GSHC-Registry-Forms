/*
 * src/services/testData.js — clearing everything made during training and
 * testing, once, just before the system goes into full use, so it starts
 * fresh.
 *
 * Removed: every form, saved copy and notification; the Process Registry's
 * cases, documents, later processes and diary dates; the nominal roll,
 * staff folders and leave applications; the whole cash flow (items,
 * releases of funds, mandatories, printed sheets, the overhead entered and
 * their numbering); every user account except the
 * administrator clearing it and the built-in administrator, with their
 * sign-in sessions and invitation or reset links; the whole audit log; and
 * all numbering (suits, invoices, leave letters) and the court rotation,
 * which start again from 1.
 *
 * Kept, as the system's configuration: units and their forms, signing
 * rules, Process Registry settings (case types, fees), leave and personnel
 * settings, email switches, and the list of backups.
 *
 * A backup of everything is made first; no backup, no clearing. It works
 * once only: afterwards it is refused, so it can never touch real records.
 */
const mongoose = require('mongoose');
const backup = require('./backup');
const { Record, DocumentCopy, Notification, AuditLog, Case, CaseDocument, CaseProcess, DiaryEntry, User, PasswordToken, Staff, StaffDocument, Leave,
  CashItem, CashSheet, CashRelease, CashMandatory } = require('../models');
const config = require('../config');

const CONFIRM = 'CLEAR TEST DATA';
// Every collection of the system is either cleared (users and links: all
// but the administrators kept) or kept as configuration. A test checks that
// a new collection is never left out of both.
const CLEARED = ['records', 'documentcopies', 'notifications', 'cases', 'casedocuments', 'caseprocesses', 'diaryentries', 'staffs', 'staffdocuments', 'leaves',
  'users', 'passwordtokens', 'auditlogs', 'cashitems', 'cashsheets', 'cashreleases', 'cashmandatories'];
const KEPT = ['units', 'formconfigs', 'backups'];
const KEY = 'testDataCleared';
const meta = () => mongoose.connection.collection('appmeta');

// The accounts that stay: the administrator clearing it, and the built-in one.
const kept = (keepUserId) => ({ $or: [{ _id: keepUserId }, { username: config.adminUsername }] });
async function counts(keepUserId) {
  const [records, signed, copies, notifications, cases, users, staff, leave, cashItems, cashReleases, cashMandatories] = await Promise.all([
    Record.countDocuments(), Record.countDocuments({ status: { $in: ['final', 'revoked'] } }),
    DocumentCopy.countDocuments(), Notification.countDocuments(), Case.countDocuments(),
    keepUserId ? User.countDocuments({ $nor: [kept(keepUserId)] }) : User.countDocuments({ username: { $ne: config.adminUsername } }),
    Staff.countDocuments(), Leave.countDocuments(), CashItem.countDocuments(), CashRelease.countDocuments(), CashMandatory.countDocuments()
  ]);
  return { records, signed, copies, notifications, cases, users, staff, leave, cashItems, cashReleases, cashMandatories };
}

async function status(keepUserId) {
  const done = await meta().findOne({ _id: KEY });
  return done ? { available: false, done: { at: done.at, by: done.by, counts: done.counts } } : { available: true, counts: await counts(keepUserId) };
}

/** Clear the test documents. Throws with .status 400 (wrong word), 409 (done already) or 503 (no backup). */
async function clear({ confirm, by, keepUserId }) {
  if (String(confirm || '').trim().toUpperCase() !== CONFIRM) {
    throw Object.assign(new Error(`Type ${CONFIRM} to confirm.`), { status: 400 });
  }
  if (!keepUserId) throw Object.assign(new Error('The administrator clearing it must be signed in.'), { status: 400 });
  if (await meta().findOne({ _id: KEY })) {
    throw Object.assign(new Error('The test data was already cleared. This can only be done once.'), { status: 409 });
  }
  // A backup first, so nothing is truly lost; no backup, no clearing.
  let saved;
  try { saved = await backup.run({ reason: 'manual', by }); }
  catch (e) { throw Object.assign(new Error(`Nothing was cleared, because the backup first failed: ${e.message}`), { status: e.status === 409 ? 409 : 503 }); }

  const before = await counts(keepUserId);
  // Claimed before deleting, so two administrators cannot both run it.
  try { await meta().insertOne({ _id: KEY, at: new Date(), by, counts: before, backupFile: saved.file }); }
  catch (e) {
    if (e.code === 11000) throw Object.assign(new Error('The test data was already cleared.'), { status: 409 });
    throw e;
  }

  const stay = (await User.find(kept(keepUserId), '_id').lean()).map(u => String(u._id));
  await Promise.all([
    Record.deleteMany({}), DocumentCopy.deleteMany({}), Notification.deleteMany({}),
    // Process Registry test cases: suit numbers start again at 1, and the
    // court rotation starts again from High Court 1.
    Case.deleteMany({}), CaseDocument.deleteMany({}), CaseProcess.deleteMany({}), DiaryEntry.deleteMany({}), // the scanned files stay in the backup's store
    // Personnel: the roll, staff folders and leave (a new roll is imported for real use).
    Staff.deleteMany({}), StaffDocument.deleteMany({}), Leave.deleteMany({}),
    // The cash flow: items, releases of funds, mandatories and printed sheets (their attachments stay in the backup's store).
    CashItem.deleteMany({}), CashSheet.deleteMany({}), CashRelease.deleteMany({}), CashMandatory.deleteMany({}),
    // Every account but the administrators kept, their links and their sessions.
    User.deleteMany({ _id: { $nin: stay } }), PasswordToken.deleteMany({ user: { $nin: stay } }),
    mongoose.connection.collection('sessions').deleteMany({ $nor: stay.map(id => ({ session: { $regex: `"userId":"${id}"` } })) }),
    AuditLog.deleteMany({}),
    meta().deleteMany({ _id: { $in: [/^hearingDigest:/, /^caseSeq:/, /^invoiceSeq:/, /^rotation:/, /^leaveSeq:/,
      // The cash flow's numbering (items, releases, mandatories) and the overhead entered in training.
      /^cashSeq:/, /^cashRelSeq:/, /^cashManSeq:/, 'cashflowReleases'] } })
  ]);
  return { counts: before, backupFile: saved.file };
}

module.exports = { status, clear, CONFIRM, CLEARED, KEPT };

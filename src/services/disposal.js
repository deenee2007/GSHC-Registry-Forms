/*
 * src/services/disposal.js — a case disposed of, and reopened.
 *
 * Recording the remark (in the Case Register or with a sitting's outcome in
 * the Court Diary) disposes of the case and locks it: from then on it can
 * only be viewed, reported on and counted. Its dates still fixed after the
 * disposal leave the Court Diary, and are kept with the disposal.
 *
 * A remark entered in error is undone by the person who recorded it, the
 * same day; after that only an administrator reopens the case, giving the
 * reason. Either way the case is pending again, the disposal is kept in its
 * reopening history, and its dates still to come return to the diary.
 */
const { DiaryEntry } = require('../models');

const KEEP = ['unitKey', 'date', 'time', 'suitNumber', 'parties', 'nature', 'counsel', 'counselSecond', 'business', 'notes', 'createdBy', 'createdByName'];
const today = () => new Date().toISOString().slice(0, 10);
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

async function dispose(c, { remark, date, user }) {
  const later = await DiaryEntry.find({ case: c._id, status: 'fixed', date: { $gt: date } }).lean();
  c.disposal = {
    remark: String(remark).slice(0, 300), date, byName: user.fullName, byId: user._id, at: new Date(),
    removedDates: later.map(e => Object.fromEntries(KEEP.map(k => [k, e[k]])))
  };
  c.status = 'disposed';
  await c.save();
  if (later.length) await DiaryEntry.deleteMany({ _id: { $in: later.map(e => e._id) } });
  return later.length;
}

// Who may undo the remark now: the person who recorded it, the same day.
const canUndo = (c, user) => !!(c.status === 'disposed' && c.disposal && c.disposal.byId &&
  String(c.disposal.byId) === String(user._id) && sameDay(c.disposal.at, new Date()));

async function reopen(c, { user, reason, kind }) {
  const d = c.disposal || {};
  c.reopenLog = [...(c.reopenLog || []), {
    kind, remark: d.remark, date: d.date, disposedBy: d.byName, disposedAt: d.at,
    reason: String(reason || '').slice(0, 500), byName: user.fullName, at: new Date()
  }];
  const back = (d.removedDates || []).filter(x => x.date >= today() && x.unitKey === c.assignedUnit);
  c.disposal = null;
  c.status = 'received';
  await c.save();
  if (back.length) await DiaryEntry.insertMany(back.map(x => ({ ...x, case: c._id, status: 'fixed', updatedByName: user.fullName })));
  return back.length;
}

module.exports = { dispose, reopen, canUndo };

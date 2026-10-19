/*
 * src/services/hearings.js — court dates from signed documents, for the
 * Home page and the day before email.
 *
 * Every signed (final) document that fixes a court date (hearing notice,
 * summonses, subpoenas, cause list, remand return date and so on) carries
 * it in record.events. On each working day, from REMINDER_HOUR (07:00 by
 * default), the people of each court with email are sent one message
 * listing the next working day's dates (on Friday, Monday's). It respects
 * the same email switches as the other alerts.
 */
const mongoose = require('mongoose');
const config = require('../config');
const mail = require('./mail');
const settings = require('./settings');
const catalogue = require('../forms/catalogue');
const { Record, Unit, User } = require('../models');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const longDay = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// "9:00", "9.30", "10", "2:30pm" as minutes, for ordering; unknown last.
function minutes(t) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i.exec(String(t || '').trim());
  if (!m) return 24 * 60;
  let h = parseInt(m[1], 10);
  if (m[3] && /pm/i.test(m[3]) && h < 12) h += 12;
  return h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

// "Musa Bello v. Ali Sani" from whichever party boxes the form has.
function parties(data, summary) {
  const pick = (...names) => { const n = names.find(k => typeof data[k] === 'string' && data[k].trim()); return n ? data[n].trim().replace(/\s+/g, ' ') : ''; };
  const a = pick('plaintiff', 'complainant', 'appellant', 'applicant');
  const b = pick('defendant', 'respondent');
  return (a && b ? `${a} v. ${b}` : a || b || summary || '').slice(0, 200);
}

/** Court dates between two YYYY-MM-DD days (inclusive), for the given units (null: all). */
async function list({ from, to, unitKeys }) {
  const q = { status: 'final', events: { $elemMatch: { date: { $gte: from, $lte: to } } } };
  if (unitKeys) q.unitKey = { $in: unitKeys };
  const recs = await Record.find(q).select('unitKey formType ref summary caseNos events data').limit(2000).lean();
  const units = Object.fromEntries((await Unit.find({}, 'key name').lean()).map(u => [u.key, u.name]));
  const out = [];
  for (const r of recs) {
    const def = catalogue.get(r.formType);
    for (const e of r.events) {
      if (e.date < from || e.date > to) continue;
      out.push({ id: String(r._id), date: e.date, time: e.time, what: e.what, formLabel: def ? def.label : r.formType,
        unitKey: r.unitKey, unitName: units[r.unitKey] || r.unitKey, caseNo: (r.caseNos && r.caseNos[0]) || r.ref || '', parties: parties(r.data || {}, r.summary) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || minutes(a.time) - minutes(b.time) || a.caseNo.localeCompare(b.caseNo));
}

// The next court day after today: Monday after a Friday. None at weekends,
// when Friday's message has already covered Monday.
function nextCourtDay(now) {
  const dow = now.getDay();
  if (dow === 0 || dow === 6) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (dow === 5 ? 3 : 1));
  return iso(d);
}

function digestMessage(user, day, items, link) {
  const byUnit = new Map();
  items.forEach(i => { if (!byUnit.has(i.unitName)) byUnit.set(i.unitName, []); byUnit.get(i.unitName).push(i); });
  const paragraphs = [`Dear ${user.fullName},`, `These court dates fixed in signed documents are on ${longDay(day)}:`];
  for (const [unit, list] of byUnit) {
    paragraphs.push(`${unit}:`);
    list.forEach(i => paragraphs.push(`${i.time ? i.time + ' · ' : ''}${i.caseNo || 'No case number'}${i.parties ? ' · ' + i.parties : ''} · ${i.what}`));
  }
  paragraphs.push('Dates come from hearing notices, summonses, subpoenas, cause lists and other signed documents. A date changed in court but not yet on a new document will not show here.');
  return {
    subject: `GSHC Registry: ${items.length} court date(s) on ${longDay(day)}`,
    ...mail.layout({ heading: `Court dates for ${longDay(day)}`, paragraphs, button: 'Open GSHC Registry', link,
      footer: 'You can switch these emails off under My Account. Directorate of ICT, Gombe State High Court of Justice.' })
  };
}

/**
 * Send the day before email once for today. Returns { day, sent } or null
 * when not due (weekend, too early, already sent, email off).
 */
async function sendDigest(now = new Date()) {
  if (!mail.enabled() || !(await settings.get()).emailAlerts) return null;
  if (now.getHours() < config.reminderHour) return null;
  const day = nextCourtDay(now);
  if (!day) return null;
  const meta = mongoose.connection.collection('appmeta');
  try { await meta.insertOne({ _id: `hearingDigest:${iso(now)}`, day, at: new Date() }); }
  catch (e) { if (e.code === 11000) return null; throw e; } // already sent today (or sending)

  const items = await list({ from: day, to: day, unitKeys: null });
  const users = await User.find({ active: true, emailAlerts: { $ne: false }, emailAlertsBlocked: { $ne: true },
    email: { $type: 'string' }, 'unitKeys.0': { $exists: true } });
  const link = config.publicBaseUrl ? config.publicBaseUrl + '/' : '';
  let sent = 0;
  for (const u of users) {
    const mine = items.filter(i => u.unitKeys.includes(i.unitKey));
    if (!mine.length) continue;
    try { await mail.send({ to: u.email, name: u.fullName, ...digestMessage(u, day, mine, link) }); sent++; }
    catch (e) { console.error(`Hearing reminder to ${u.username} failed: ${e.message}`); }
  }
  await meta.updateOne({ _id: `hearingDigest:${iso(now)}` }, { $set: { items: items.length, sent } });
  if (sent) console.log(`Hearing reminders: ${items.length} court date(s) on ${day}, ${sent} email(s) sent.`);
  return { day, items: items.length, sent };
}

let timers = [];
async function tick() {
  try { await sendDigest(); } catch (e) { console.error(`Hearing reminders failed: ${e.message}`); }
}
function start() {
  timers = [setTimeout(tick, 3 * 60000), setInterval(tick, 30 * 60000)];
  timers.forEach(t => t.unref());
}

module.exports = { list, nextCourtDay, sendDigest, digestMessage, start, minutes, iso };

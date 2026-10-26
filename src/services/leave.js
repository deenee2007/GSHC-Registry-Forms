/*
 * src/services/leave.js — the rules for leave, kept in Settings (Personnel)
 * so the court can set its own: the kinds of leave and the days allowed
 * (annual leave by grade level), whether days are working days, public
 * holidays, whether a relief officer must be named, and the route an
 * application goes (through the Staff Officer to the Director Personnel,
 * or to the Chief Registrar for senior officers). The figures here are
 * only a start, to be confirmed by the Directorate of Personnel.
 */
const mongoose = require('mongoose');

const KEY = 'leaveSettings';
const meta = () => mongoose.connection.collection('appmeta');
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// days: the days allowed in a year (0: no fixed number, as approved); "gl": annual leave by grade level.
const DEFAULTS = {
  types: [
    { key: 'annual', name: 'Annual leave', days: 'gl', working: true },
    { key: 'casual', name: 'Casual leave', days: 7, working: true },
    { key: 'sick', name: 'Sick leave', days: 0, working: false },
    { key: 'maternity', name: 'Maternity leave', days: 112, working: false, sex: 'F' },
    { key: 'paternity', name: 'Paternity leave', days: 14, working: true, sex: 'M' },
    { key: 'study', name: 'Study leave', days: 0, working: false },
    { key: 'examination', name: 'Examination leave', days: 0, working: true },
    { key: 'compassionate', name: 'Compassionate leave', days: 0, working: true }
  ],
  annualJunior: 21,          // annual leave days below annualSeniorFromGl
  annualSenior: 30,
  annualSeniorFromGl: '07',
  seniorFromGl: '15',        // from this grade level the Chief Registrar gives the approval
  reliefRequired: false,
  holidays: []               // YYYY-MM-DD public holidays, not counted as working days
};

async function getSettings() {
  const doc = await meta().findOne({ _id: KEY });
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (doc) for (const k of Object.keys(DEFAULTS)) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

const GL = /^(0[1-9]|1[0-7])$/;
async function setSettings(input) {
  const next = await getSettings();
  if (input.types !== undefined) {
    if (!Array.isArray(input.types) || !input.types.length) throw bad('Keep at least one kind of leave.');
    const seen = new Set();
    next.types = input.types.map(t => {
      const name = String(t.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!name) throw bad('Every kind of leave needs a name.');
      const key = String(t.key || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')).slice(0, 40);
      if (seen.has(key)) throw bad(`${name} is listed twice.`);
      seen.add(key);
      const days = t.days === 'gl' ? 'gl' : Number(t.days);
      if (days !== 'gl' && !(Number.isInteger(days) && days >= 0 && days <= 400)) throw bad(`Days for ${name} must be a whole number (0 for no fixed number).`);
      return { key, name, days, working: !!t.working, sex: ['M', 'F'].includes(t.sex) ? t.sex : '' };
    });
  }
  for (const k of ['annualJunior', 'annualSenior']) if (input[k] !== undefined) {
    const n = Number(input[k]);
    if (!(Number.isInteger(n) && n > 0 && n <= 90)) throw bad('Annual leave days must be a whole number.');
    next[k] = n;
  }
  for (const k of ['annualSeniorFromGl', 'seniorFromGl']) if (input[k] !== undefined) {
    const g = String(input[k]).padStart(2, '0');
    if (!GL.test(g)) throw bad('Choose a grade level from 01 to 17.');
    next[k] = g;
  }
  if (input.reliefRequired !== undefined) next.reliefRequired = !!input.reliefRequired;
  if (input.holidays !== undefined) {
    if (!Array.isArray(input.holidays)) throw bad('Invalid list of holidays.');
    next.holidays = [...new Set(input.holidays.map(String).map(x => x.trim()).filter(Boolean))].sort();
    if (next.holidays.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw bad('Give each public holiday as a date.');
  }
  await meta().updateOne({ _id: KEY }, { $set: next }, { upsert: true });
  return next;
}

const glNum = (gl) => gl === 'Cons.' ? 99 : Number(gl) || 0;

// The days of a kind of leave allowed in a year for an officer (0: no fixed number).
// A kind of leave for one sex only (maternity, paternity) is not offered to the other.
const offered = (type, staff) => !type.sex || !staff.sex || type.sex === staff.sex;
function allowed(type, staff, s) {
  if (type.days !== 'gl') return type.days;
  return glNum(staff.gl) >= Number(s.annualSeniorFromGl) ? s.annualSenior : s.annualJunior;
}

// The route: through the Staff Officer to the Director Personnel; for a
// senior officer, on to the Chief Registrar; for the Chief Registrar, the
// Hon. Chief Judge.
function route(staff, s) {
  const n = glNum(staff.gl);
  const steps = [{ role: 'staff_officer', label: 'Staff Officer', action: 'Forward' }];
  if (staff.gl === 'Cons.') steps.push({ role: 'chief_judge', label: 'Hon. Chief Judge', action: 'Approve' });
  else if (n >= Number(s.seniorFromGl)) steps.push({ role: 'director_personnel', label: 'Director Personnel', action: 'Recommend' }, { role: 'chief_registrar', label: 'Chief Registrar', action: 'Approve' });
  else steps.push({ role: 'director_personnel', label: 'Director Personnel', action: 'Approve' });
  return steps;
}

// Dates: from the first day and the number of days, the last day and the
// day to resume. Working days leave out Saturdays, Sundays and holidays.
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (x) => new Date(x + 'T12:00:00Z');
function isWorking(d, holidays) { const w = d.getUTCDay(); return w !== 0 && w !== 6 && !holidays.includes(iso(d)); }
function span(from, days, working, holidays) {
  let d = parse(from);
  if (working) while (!isWorking(d, holidays)) d.setUTCDate(d.getUTCDate() + 1);
  const first = iso(d);
  let n = 0, last = first;
  for (let guard = 0; n < days && guard < 2000; guard++) {
    if (!working || isWorking(d, holidays)) { n++; last = iso(d); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const r = parse(last); r.setUTCDate(r.getUTCDate() + 1);
  while (!isWorking(r, holidays)) r.setUTCDate(r.getUTCDate() + 1);
  return { from: first, to: last, resume: iso(r) };
}

module.exports = { getSettings, setSettings, allowed, offered, route, span, DEFAULTS };

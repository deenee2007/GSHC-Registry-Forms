/*
 * src/services/registerImport.js — a court's existing register book, from
 * an Excel or CSV sheet, into its Case Register (and its next dates into
 * the Court Diary).
 *
 * The sheet has a heading row with the columns of the book, in any order:
 * S/No, Register (Civil or Criminal), Name of case, Suit number, Date of
 * filing, Date of assignment, Type of case, Date received, Date of
 * disposal, Remarks, and optionally Next date and Coming up for. Every row
 * is checked first: a row with a problem is listed and left out; nothing
 * is saved until the court confirms. Dates are read day first (12/03/2024
 * is 12 March 2024), as written in Nigeria.
 */
const { Case, DiaryEntry } = require('../models');
const catalogue = require('../forms/catalogue');
const processSvc = require('./process');
const sheetReader = require('./sheetReader');

const MAX_ROWS = 5000;
// Heading words for each column, the more particular first.
const COLUMNS = [
  ['remarks', /remark/], ['disposal', /dispos/], ['received', /receiv/], ['assigned', /assign/], ['filed', /fil(ing|ed)/],
  ['nextDate', /next/], ['business', /coming up|business|purpose|stage/], ['nature', /type of case|nature/],
  ['register', /register|book|case type|civil|criminal/], ['parties', /name of case|parties|case name|title/],
  ['sn', /^s ?no$|^serial|^no$/], ['suit', /suit|case no|number/]
];
const DATE_COLS = ['filed', 'assigned', 'received', 'disposal', 'nextDate'];
const LABELS = { filed: 'Date of filing', assigned: 'Date of assignment', received: 'Date received', disposal: 'Date of disposal', nextDate: 'Next date' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1900 && y <= 2100; };
const fullYear = (y) => y < 100 ? (y > 50 ? 1900 + y : 2000 + y) : y;

/** A date as YYYY-MM-DD, '' when empty, or null when it cannot be read. */
function readDate(v) {
  if (v === '' || v == null) return '';
  if (typeof v === 'number') { // an Excel day number
    if (v < 1 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return '';
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) { const [y, mo, d] = [+m[1], +m[2], +m[3]]; return valid(y, mo, d) ? iso(y, mo, d) : null; }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) { const [d, mo, y] = [+m[1], +m[2], fullYear(+m[3])]; return valid(y, mo, d) ? iso(y, mo, d) : null; }
  if ((m = /^(\d{1,2})[ -]([a-z]+)\.?[ -](\d{2}|\d{4})$/.exec(s))) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3)) + 1, y = fullYear(+m[3]);
    return mo && valid(y, mo, +m[1]) ? iso(y, mo, +m[1]) : null;
  }
  if ((m = /^([a-z]+)\.? (\d{1,2}) (\d{4})$/.exec(s))) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    return mo && valid(+m[3], mo, +m[2]) ? iso(+m[3], mo, +m[2]) : null;
  }
  return null;
}

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
function mapHeadings(row) {
  const map = {};
  row.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    const hit = COLUMNS.find(([key, rx]) => map[key] === undefined && rx.test(n));
    if (hit) map[hit[0]] = i;
  });
  return map;
}

// "Musa Bello v. Ali Sani" into its two sides.
function splitParties(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  const m = /^(.*?)\s+(?:v|vs|versus)\.?\s+(.*)$/i.exec(t);
  return m ? [m[1].trim(), m[2].trim()] : [t, ''];
}

// The case type: one named in the Register column, the letter in the suit
// number (GM/45c/2026), or the first type of the book named.
function caseTypeFor(regText, suitNumber, types) {
  const r = String(regText || '').trim().toLowerCase();
  const byLabel = r && types.find(t => t.label.toLowerCase() === r || t.key === r);
  if (byLabel) return { type: byLabel };
  const letter = (/\/\d+([a-z]+)\//i.exec(suitNumber || '') || [])[1];
  const bySuffix = letter && types.find(t => t.suffix === letter.toLowerCase());
  const book = /crim/.test(r) ? 'criminal' : /civ/.test(r) ? 'civil' : null;
  if (bySuffix && (!book || bySuffix.book === book)) return { type: bySuffix };
  if (book) return { type: types.find(t => t.book === book && !t.suffix) || types.find(t => t.book === book) || types[0] };
  return { type: bySuffix || types.find(t => t.book === 'civil' && !t.suffix) || types[0], guessed: !bySuffix };
}

/**
 * Check every row. Returns { rows: [{ line, ok, suitNumber, parties, book,
 * status, problems, notes, doc, next }], toAdd, skipped }.
 */
async function analyse(buffer, fileName, unit) {
  const rows = sheetReader.read(buffer, fileName);
  const headAt = rows.findIndex(r => r.some(c => /suit/.test(norm(c))));
  if (headAt < 0) throw Object.assign(new Error('No heading row with a "Suit number" column was found. Use the template: its first row names the columns.'), { status: 400 });
  const map = mapHeadings(rows[headAt]);
  const body = rows.slice(headAt + 1);
  if (body.length > MAX_ROWS) throw Object.assign(new Error(`The sheet has ${body.length} rows; import at most ${MAX_ROWS} at a time.`), { status: 400 });
  const settings = await processSvc.getSettings();
  const cell = (r, key) => map[key] === undefined ? '' : (r[map[key]] === undefined ? '' : r[map[key]]);
  const text = (r, key, max = 300) => String(cell(r, key)).trim().replace(/\s+/g, ' ').slice(0, max);
  const today = new Date(); const todayIso = iso(today.getFullYear(), today.getMonth() + 1, today.getDate());

  const numbers = body.map(r => text(r, 'suit', 60)).filter(Boolean);
  const existing = new Map((await Case.find({ suitNumber: { $in: numbers } }, 'suitNumber assignedUnit').lean()).map(c => [c.suitNumber.toLowerCase(), c]));
  const seen = new Set();
  const out = [];
  body.forEach((r, i) => {
    if (!r.some(c => String(c).trim())) return; // a blank row
    const line = headAt + i + 2;
    const suitNumber = text(r, 'suit', 60);
    const problems = [], notes = [];
    const dates = {};
    for (const k of DATE_COLS) {
      const d = readDate(cell(r, k));
      if (d === null) problems.push(`${LABELS[k]} "${cell(r, k)}" cannot be read (write it as 12/03/2024 or 12 March 2024)`);
      else dates[k] = d;
    }
    if (!suitNumber) problems.push('No suit number');
    else if (seen.has(suitNumber.toLowerCase())) problems.push('Appears twice in this sheet');
    else if (existing.has(suitNumber.toLowerCase())) problems.push('Already in a Case Register');
    if (suitNumber) seen.add(suitNumber.toLowerCase());
    const { type, guessed } = caseTypeFor(cell(r, 'register'), suitNumber, settings.caseTypes);
    if (guessed) notes.push(`Register not given: put in the ${type.book === 'criminal' ? 'Criminal' : 'Civil'} Register`);
    const [firstParty, secondParty] = splitParties(cell(r, 'parties'));
    const remark = text(r, 'remarks');
    let disposed = !!dates.disposal;
    if (remark && !dates.disposal) notes.push('Remark left out: there is no date of disposal (add it if the case was disposed of)');
    let next = null;
    if (dates.nextDate) {
      if (disposed) notes.push('Next date left out: the case is disposed of');
      else if (dates.nextDate < todayIso) notes.push('Next date left out: it has passed');
      else {
        const business = text(r, 'business', 80) || 'Mention';
        if (!text(r, 'business')) notes.push('Coming up for not given: Mention used');
        next = { date: dates.nextDate, business };
      }
    }
    const ok = !problems.length;
    out.push({
      line, ok, suitNumber, parties: [firstParty, secondParty].filter(Boolean).join(' v. '), book: type.book,
      status: disposed ? 'Disposed of' : 'Pending', problems, notes, next,
      doc: ok ? {
        caseType: type.key, suitNumber, earlier: true, caseNos: [catalogue.normalizeCase(suitNumber)],
        firstParty: firstParty.slice(0, 1000), secondParty: secondParty.slice(0, 1000), nature: text(r, 'nature'),
        filedOn: dates.filed || undefined, assignedUnit: unit.key,
        assignedAt: dates.assigned ? new Date(dates.assigned + 'T12:00:00Z') : undefined,
        receivedAt: dates.received ? new Date(dates.received + 'T12:00:00Z') : undefined,
        status: disposed ? 'disposed' : 'received',
        disposal: disposed ? { remark: remark || 'Disposed of', date: dates.disposal } : null
      } : null
    });
  });
  if (!out.length) throw Object.assign(new Error('The sheet has no cases under its heading row.'), { status: 400 });
  return { rows: out, toAdd: out.filter(r => r.ok).length, skipped: out.filter(r => !r.ok).length, columns: Object.keys(map) };
}

/** Save the rows that passed; their next dates go into the diary. */
async function commit(result, user) {
  const ok = result.rows.filter(r => r.ok);
  const by = { receivedByName: user.fullName, createdBy: user._id, createdByName: user.fullName };
  let added = 0, dates = 0;
  const failed = [];
  for (const r of ok) {
    try {
      const doc = { ...r.doc, ...by };
      if (doc.disposal) doc.disposal = { ...doc.disposal, byName: user.fullName, at: new Date() };
      const c = await Case.create(doc);
      added++;
      if (r.next) {
        await DiaryEntry.create({ unitKey: c.assignedUnit, date: r.next.date, case: c._id, suitNumber: c.suitNumber,
          parties: [c.firstParty, c.secondParty].filter(Boolean).join(' v. '), nature: c.nature, business: r.next.business,
          createdBy: user._id, createdByName: user.fullName, updatedByName: user.fullName });
        dates++;
      }
    } catch (e) {
      failed.push({ line: r.line, suitNumber: r.suitNumber, problem: e.code === 11000 ? 'Already in a Case Register' : e.message });
    }
  }
  return { added, dates, failed };
}

module.exports = { analyse, commit, readDate, splitParties, mapHeadings, caseTypeFor };

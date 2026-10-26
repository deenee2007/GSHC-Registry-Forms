/*
 * src/services/personnelImport.js — a nominal roll from Excel or CSV into
 * the staff records. The heading row names the columns, in any order, as on
 * the roll: S/No, Name, Sex, Rank, Highest qualification, GL, PSN, DOB,
 * DOFA, LGA, Contract, DOPA, and the expected dates of retirement by age
 * and by service; optionally Step, Station, Date of confirmation, Contract
 * end date, Phone and Email.
 *
 * Every row is checked first and nothing is saved until the registry
 * confirms. Typed dates are read day first (12/03/1990 is 12 March 1990).
 * A date Excel holds as a date may have had its day and month swapped when
 * it was typed; where the sheet gives the date of retirement, the date that
 * agrees with it is taken. A date that cannot be settled is kept as read
 * and the record marked "check the dates".
 */
const { Staff, retirement } = require('../models');
const personnel = require('./personnel');
const sheetReader = require('./sheetReader');
const { readDate } = require('./registerImport');

const MAX_ROWS = 5000;
const COLUMNS = [
  ['retAge', /ret\w* .*age/], ['retService', /ret\w* .*serv/], ['contractEnds', /contract .*(end|expir)|end of contract/], ['contract', /contract/],
  ['confirmedOn', /confirm/], ['dob', /^dob$|birth/], ['dofa', /^dofa$|first appoint/], ['dopa', /^dopa$|present appoint|last promot/],
  ['qualification', /qualif/], ['station', /station|posting|posted/], ['sn', /^s ?no$|^serial/], ['psn', /psn|file no/],
  ['name', /name/], ['sex', /^sex$|gender/], ['rank', /rank|designation/], ['step', /^step$/], ['gl', /^gl$|grade/],
  ['lga', /^lga$|local gov/], ['phone', /phone|gsm|mobile/], ['email', /mail/]
];
const DATES = { dob: 'Date of birth', dofa: 'Date of first appointment', dopa: 'Date of present appointment', confirmedOn: 'Date of confirmation', contractEnds: 'Contract end date' };
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const long = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
// The same date with its day and month the other way, where both could be a month.
const swapped = (d) => { const [y, m, dd] = d.split('-'); return +dd <= 12 && dd !== m ? `${y}-${dd}-${m}` : null; };

function mapHeadings(row) {
  const map = {};
  row.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    const hit = COLUMNS.find(([k, rx]) => map[k] === undefined && rx.test(n));
    if (hit) map[hit[0]] = i;
  });
  return map;
}

// A date cell: { value, excel } where excel marks a date Excel holds as a
// date (its day and month may be swapped); year only means 1 January.
function dateCell(v) {
  if (v === '' || v == null) return { value: '' };
  if (/^\s*\d{4}\s*$/.test(String(v)) && Number(v) >= 1900 && Number(v) <= 2100) return { value: `${String(v).trim()}-01-01`, yearOnly: true };
  const value = readDate(v);
  if (value === null) return { value: null };
  return { value, excel: typeof v === 'number' && !!swapped(value) };
}

async function analyse(buffer, fileName) {
  const rows = sheetReader.read(buffer, fileName);
  const headAt = rows.findIndex(r => r.some(c => /^psn$|psn|file no/.test(norm(c))));
  if (headAt < 0) throw Object.assign(new Error('No heading row with a "PSN" column was found. Use the template: its first row names the columns.'), { status: 400 });
  const map = mapHeadings(rows[headAt]);
  if (map.name === undefined) throw Object.assign(new Error('The heading row has no "Name" column.'), { status: 400 });
  const body = rows.slice(headAt + 1);
  if (body.length > MAX_ROWS) throw Object.assign(new Error(`The sheet has ${body.length} rows; import at most ${MAX_ROWS} at a time.`), { status: 400 });
  const s = await personnel.getSettings();
  const findRank = personnel.rankFinder(s.ranks);
  const stations = new Map(s.stations.map(x => [personnel.key(x), x]));
  const cell = (r, k) => map[k] === undefined || r[map[k]] === undefined ? '' : r[map[k]];
  const text = (r, k, max = 200) => String(cell(r, k)).trim().replace(/\s+/g, ' ').slice(0, max);
  const psnOf = (r) => text(r, 'psn', 40).replace(/\.0+$/, '');
  const onRoll = new Set((await Staff.find({ psn: { $in: body.map(psnOf).filter(Boolean) } }, 'psn').lean()).map(x => x.psn));
  const seen = new Set();
  const today = new Date().toISOString().slice(0, 10);
  const out = [];

  body.forEach((r, i) => {
    if (!r.some(c => String(c).trim())) return;
    const line = headAt + i + 2;
    const problems = [], notes = [];
    let check = false;
    const psn = psnOf(r), name = text(r, 'name');
    if (!name && !psn) return; // a heading or total line, not an officer
    if (!psn) problems.push('No PSN.');
    else if (seen.has(psn)) problems.push(`PSN ${psn} is given twice in the sheet.`);
    else if (onRoll.has(psn)) problems.push(`PSN ${psn} is already on the roll.`);
    if (psn) seen.add(psn);
    if (!name) problems.push('No name.');

    const doc = { psn, name, history: [] };
    const sx = text(r, 'sex').toUpperCase();
    doc.sex = /^M/.test(sx) ? 'M' : /^F/.test(sx) ? 'F' : '';
    if (sx && !doc.sex) notes.push(`Sex "${sx}" not read.`);
    const rankText = text(r, 'rank');
    const rank = rankText && findRank(rankText);
    doc.rank = rank ? rank.name : rankText;
    doc.cadre = rank ? rank.cadre : '';
    if (rankText && !rank) notes.push(`Rank "${rankText}" is not in the list of ranks (Settings): kept as written.`);
    const glText = text(r, 'gl');
    doc.gl = glText ? personnel.readGl(glText) || '' : '';
    if (glText && !doc.gl) notes.push(`GL "${glText}" not read.`);
    const step = text(r, 'step');
    doc.step = step && Number.isInteger(Number(step)) ? Number(step) : null;
    doc.qualification = text(r, 'qualification');
    const lgaText = text(r, 'lga');
    doc.lga = personnel.findLga(lgaText);
    if (lgaText && !doc.lga) notes.push(`LGA "${lgaText}" is not a local government of Gombe State.`);
    const stText = text(r, 'station');
    doc.station = stations.get(personnel.key(stText)) || stText;
    if (stText && !stations.has(personnel.key(stText))) notes.push(`Station "${stText}" is not in the list of stations (Settings): kept as written.`);
    doc.contract = /contract|^y(es)?$|^true$/i.test(text(r, 'contract'));
    doc.phone = text(r, 'phone', 40);
    doc.email = text(r, 'email', 120).toLowerCase();

    const cells = {};
    for (const [k, label] of Object.entries(DATES)) {
      const c = dateCell(cell(r, k));
      if (c.value === null) { notes.push(`${label} "${text(r, k)}" could not be read; left empty.`); check = true; c.value = ''; }
      if (c.yearOnly) { notes.push(`${label}: only the year is given; 1 January ${c.value.slice(0, 4)} is taken until corrected.`); check = true; }
      cells[k] = c;
      doc[k] = c.value;
    }
    // Settle a swapped date of birth or first appointment from the sheet's
    // own retirement date (whichever of its two columns is filled).
    const sheet = [dateCell(cell(r, 'retAge')), dateCell(cell(r, 'retService'))].find(c => c.value);
    const options = (k) => [cells[k].value, cells[k].excel && swapped(cells[k].value)].filter(Boolean);
    const ambiguous = ['dob', 'dofa'].filter(k => cells[k].excel);
    if (sheet && (doc.dob || doc.dofa)) {
      const wanted = [sheet.value, sheet.excel && swapped(sheet.value)].filter(Boolean);
      const combos = (doc.dob ? options('dob') : ['']).flatMap(dob => (doc.dofa ? options('dofa') : ['']).map(dofa => ({ dob, dofa })));
      const agree = combos.filter(x => wanted.includes(retirement(x).date));
      const asRead = agree.find(x => x.dob === doc.dob && x.dofa === doc.dofa);
      if (asRead) { /* the dates as read agree with the sheet */ }
      else if (agree.length === 1) {
        for (const k of ['dob', 'dofa']) if (agree[0][k] !== doc[k]) notes.push(`${DATES[k]} read as ${long(agree[0][k])}: the day and month were swapped in Excel (this agrees with the retirement date in the sheet).`);
        Object.assign(doc, agree[0]);
      } else {
        notes.push(`The retirement date in the sheet (${long(sheet.value)}) does not agree with the date of birth and of first appointment; the date worked out from them is used. Check them.`);
        check = true;
      }
    } else if (ambiguous.length) {
      ambiguous.forEach(k => notes.push(`${DATES[k]} ${long(doc[k])} could have its day and month swapped; check it.`));
      check = true;
    }
    for (const k of ['dopa', 'confirmedOn', 'contractEnds']) if (cells[k].excel) { notes.push(`${DATES[k]} ${long(doc[k])} could have its day and month swapped; check it.`); check = true; }
    if (!doc.dob) notes.push('No date of birth: the retirement date by age cannot be worked out.');
    if (!doc.dofa) notes.push('No date of first appointment: the retirement date by service cannot be worked out.');
    if (doc.contract && !doc.contractEnds) notes.push('Contract officer with no contract end date: add it to the record.');
    doc.checkDates = check;
    const ret = retirement(doc);
    if (ret.date && ret.date < today) notes.push(`The retirement date (${long(ret.date)}) has passed; confirm the officer's status.`);
    out.push({ line, ok: !problems.length, psn, name, rank: doc.rank, station: doc.station, retiresOn: ret.date, retiresBy: ret.by, problems, notes, check, doc });
  });
  return { rows: out, toAdd: out.filter(x => x.ok).length, skipped: out.filter(x => !x.ok).length, columns: Object.keys(map) };
}

async function commit(buffer, fileName, user) {
  const a = await analyse(buffer, fileName);
  const at = new Date();
  const added = [], failed = [];
  for (const row of a.rows.filter(x => x.ok)) {
    try {
      const s = new Staff({ ...row.doc, createdByName: user.fullName,
        history: [{ kind: 'entered', date: at.toISOString().slice(0, 10), byName: user.fullName, at,
          text: `Entered from the nominal roll "${String(fileName || '').slice(0, 80)}"${row.notes.length ? `. Found on import: ${row.notes.join(' ')}` : ''}`.slice(0, 2000) }] });
      await s.save();
      added.push(s.psn);
    } catch (e) { failed.push({ line: row.line, psn: row.psn, error: e.code === 11000 ? 'PSN already on the roll.' : e.message }); }
  }
  return { added: added.length, failed, checkDates: a.rows.filter(x => x.ok && x.check).length };
}

module.exports = { analyse, commit, mapHeadings, dateCell };

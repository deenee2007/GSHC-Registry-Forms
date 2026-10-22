/*
 * src/forms/catalogue.js — the server's copy of the form definitions.
 *
 * The forms are defined once, in public/js/modules/{registry,appeals,
 * execution}.js, for the browser. Rather than duplicating 33 schemas, the
 * server runs those same files in an isolated sandbox and reads the
 * definitions they register, so the browser and the server can never
 * disagree about a form's fields.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_DIR = path.join(__dirname, '..', '..', 'public', 'js', 'modules');

// unit type -> module file and the name the module registers under
const MODULES = {
  registry:  { file: 'registry.js',  name: 'Registry' },
  appeals:   { file: 'appeals.js',   name: 'Appeals' },
  execution: { file: 'execution.js', name: 'Execution' }
};

function load() {
  const sandbox = { window: { App: {} } };
  vm.createContext(sandbox);
  Object.values(MODULES).forEach(({ file }) => {
    const code = fs.readFileSync(path.join(MODULE_DIR, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  });
  const byModule = sandbox.window.App.allFormsByModule || {};

  const forms = {};      // formType -> { label, schema, unitType }
  const byUnitType = {}; // unitType -> [formType]
  Object.entries(MODULES).forEach(([unitType, { name }]) => {
    const defs = byModule[name] || {};
    byUnitType[unitType] = Object.keys(defs);
    Object.entries(defs).forEach(([key, def]) => {
      // JSON round trip drops the sandbox's object prototypes
      forms[key] = { label: def.label, schema: JSON.parse(JSON.stringify(def.schema || [])), unitType };
    });
  });
  return { forms, byUnitType };
}

const catalogue = load();

function get(formType) { return catalogue.forms[formType] || null; }

// Forms a unit may use: its admin chosen list, else its own module's forms.
function formsForUnit(unit) {
  if (unit.allowedForms && unit.allowedForms.length) return unit.allowedForms.filter(k => catalogue.forms[k]);
  return catalogue.byUnitType[unit.type] || [];
}

// Short reference and summary shown in record lists, mirroring the rules
// the browser used before (first full width / party field, first number field).
function describe(formType, data) {
  const def = get(formType);
  if (!def) return { ref: '', summary: '' };
  const fields = def.schema.filter(s => s.name);
  const sumField = fields.find(s => s.full && typeof data[s.name] === 'string') ||
                   fields.find(s => /title|party|name|plaintiff|appellant/i.test(s.name));
  const refField = fields.find(s => /no\.?$|number|ref|suitno/i.test(s.name) || /No\./i.test(s.label || ''));
  const text = v => (typeof v === 'string' ? v : '').slice(0, 300);
  return { ref: refField ? text(data[refField.name]) : '', summary: sumField ? text(data[sumField.name]) : '',
    caseNos: caseNumbers(formType, data), events: courtDates(formType, data) };
}

// The day (and time) a document calls people to court, for the hearing
// reminders. Only forms that fix a court date are listed.
const COURT_DATES = {
  'hearing-notice':            { date: 'hearingDate', time: 'hearingTime', what: d => d.stage ? `Hearing (${d.stage})` : 'Hearing' },
  'civil-summons':             { date: 'appearanceDate', time: 'appearanceTime', what: () => 'Defendant to appear (civil summons)' },
  'criminal-summons':          { date: 'appearanceDate', time: 'appearanceTime', what: () => 'Accused to appear (summons)' },
  'witness-summons':           { date: 'appearanceDate', time: 'appearanceTime', what: () => 'Witness to appear' },
  'bail-bond':                 { date: 'appearanceDate', time: 'appearanceTime', what: () => 'Accused on bail to appear' },
  'subpoena-ad-testificandum': { date: 'attendanceDate', time: 'attendanceTime', what: () => 'Witness to attend (subpoena)' },
  'subpoena-duces-tecum':      { date: 'attendanceDate', time: 'attendanceTime', what: () => 'Witness to attend with documents' },
  'order-to-produce-prisoner': { date: 'productionDate', time: 'productionTime', what: () => 'Prisoner to be produced' },
  'remand-warrant':            { date: 'returnDate', what: () => 'Remand ends: accused to be brought back' },
  'cause-list':                { date: 'sittingDate', time: 'sittingTime', what: d => `Court sitting: cause list of ${Array.isArray(d.entries) ? d.entries.length : 0} case(s)` },
  'summons-settle-record':     { date: 'attendanceDate', time: 'attendanceTime', what: () => 'Settling the record of appeal' },
  'notice-appeal-fixed':       { date: 'hearingDate', what: () => 'Appeal hearing' }
};

function courtDates(formType, data) {
  const c = COURT_DATES[formType];
  if (!c || !data || !/^\d{4}-\d{2}-\d{2}$/.test(String(data[c.date] || ''))) return [];
  return [{ date: data[c.date], time: c.time ? String(data[c.time] || '').slice(0, 20) : '', what: c.what(data).slice(0, 120) }];
}

// Suit, case and appeal numbers a form mentions, for the case file. Written
// the same way however they were typed: capitals, no spaces
// ("gm / 45 / 2026" is GM/45/2026).
const CASE_FIELDS = ['suitNumber', 'caseNumber', 'suitNo', 'processSuitNumber', 'processSuitNo',
  'highCourtAppealNo', 'lowerCourtSuitNo', 'appealNumber'];
const normalizeCase = (v) => String(v || '').toUpperCase().replace(/\s+/g, '').replace(/[.,;:]+$/, '').slice(0, 80);

function caseNumbers(formType, data) {
  const def = get(formType);
  if (!def || !data) return [];
  const out = [];
  for (const f of def.schema) {
    if (!f.name) continue;
    if (CASE_FIELDS.includes(f.name)) out.push(data[f.name]);
    if (f.name === 'additionalSuits') out.push(...String(data[f.name] || '').split('\n'));
    if (f.type === 'table' && Array.isArray(data[f.name]) && (f.columns || []).some(c => c.name === 'suitNumber')) {
      data[f.name].forEach(row => out.push(row && row.suitNumber));
    }
  }
  return [...new Set(out.map(normalizeCase).filter(s => s.length >= 3))];
}

// Keep only fields the schema defines; check required ones are filled.
function cleanData(formType, input) {
  const def = get(formType);
  if (!def) return { error: 'Unknown form type.' };
  input = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const f of def.schema) {
    if (!f.name) continue;
    const v = input[f.name] === undefined ? f.defaultValue : input[f.name];
    if (f.type === 'table') {
      const cols = (f.columns || []).map(c => c.name);
      const rows = Array.isArray(v) ? v.slice(0, 500) : [];
      out[f.name] = rows.map((r, i) => {
        const row = { sn: String(i + 1) };
        cols.forEach(c => { row[c] = String((r && r[c]) ?? '').slice(0, 2000).trim(); });
        return row;
      });
      if (f.required && out[f.name].length === 0) return { error: `Please add at least one entry to ${f.label}.` };
      continue;
    }
    const s = v === undefined || v === null ? '' : String(v).slice(0, 20000).trim();
    if (f.required && !s) return { error: `Please fill: ${f.label}` };
    out[f.name] = s;
  }
  return { data: out };
}

module.exports = { ...catalogue, MODULES, get, formsForUnit, describe, cleanData, caseNumbers, normalizeCase, CASE_FIELDS, COURT_DATES, courtDates };

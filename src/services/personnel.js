/*
 * src/services/personnel.js — settings of the Directorate of Personnel:
 * the stations staff are posted to, the ranks (each in a cadre, with the
 * other ways a rank is written, so an imported roll is tidied), and the
 * kinds of documents in a staff folder. Kept in appmeta, set by an
 * administrator. Also the local governments of Gombe State.
 */
const mongoose = require('mongoose');

const KEY = 'personnelSettings';
const meta = () => mongoose.connection.collection('appmeta');
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// The 11 local government areas of Gombe State, with the ways they are written.
const LGAS = [
  ['Akko'], ['Balanga'], ['Billiri'], ['Dukku'], ['Funakaye', 'F/Kaye', 'Funa kaye'], ['Gombe'], ['Kaltungo'], ['Kwami'],
  ['Nafada'], ['Shongom', 'Shongum'], ['Yamaltu/Deba', 'Y/Deba', 'Yamaltu Deba', 'Yamaltu']
];
const GLS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', 'Cons.'];
const STATUS_LABELS = { in_service: 'In service', on_leave: 'On leave', suspended: 'Suspended', retired: 'Retired', resigned: 'Resigned',
  deceased: 'Deceased', transferred_out: 'Transferred out', dismissed: 'Dismissed' };

const CADRES = ['Management', 'Magistracy', 'Area Courts', 'Registry', 'Administrative', 'Executive', 'Clerical', 'Typing and Computer',
  'Bailiffs', 'Stores', 'Drivers', 'Messengers', 'Security', 'Cleaning'];
// A first list from the ranks in use; the administrator corrects it in Settings.
const r = (name, cadre, ...aliases) => ({ name, cadre, aliases });
const RANKS = [
  r('Chief Registrar', 'Management'), r('Deputy Chief Registrar', 'Management', 'DCR'), r('Director', 'Management', 'Dir.'),
  r('Deputy Director', 'Management'), r('Assistant Director', 'Management', 'Asst. Director'),
  r('Chief Magistrate I', 'Magistracy', 'Chief Mag I', 'Chief Mag. I'), r('Chief Magistrate II', 'Magistracy', 'Chief Mag II', 'Chief Mag. II'),
  r('Principal Magistrate I', 'Magistracy'), r('Principal Magistrate II', 'Magistracy'),
  r('Senior Magistrate I', 'Magistracy', 'Snr. Magistrate I', 'Snr. Mag. I'), r('Senior Magistrate II', 'Magistracy', 'Snr. Magistrate II', 'Snr. Mag. II'),
  r('Magistrate Grade I', 'Magistracy', 'Magistrate Grd I', 'Magistrate I'), r('Magistrate Grade II', 'Magistracy', 'Magistrate Grd II', 'Magistrate II'),
  r('Upper Area Court Judge I', 'Area Courts', 'UACJ I'), r('Upper Area Court Judge II', 'Area Courts', 'UACJ II'),
  r('Principal Area Court Judge I', 'Area Courts', 'PACJ I'), r('Principal Area Court Judge II', 'Area Courts', 'PACJ II'),
  r('Senior Area Court Judge I', 'Area Courts', 'SACJ I'), r('Senior Area Court Judge II', 'Area Courts', 'SACJ II'),
  r('Senior Area Court Judge', 'Area Courts', 'Snr. Area Court Judge'), r('Higher Area Court Judge', 'Area Courts', 'HACJ', 'Higher Court Judge'),
  r('Area Court Judge', 'Area Courts'),
  r('Higher Court Member', 'Area Courts'), r('Senior Court Member', 'Area Courts', 'Snr. Court Member'), r('Court Member', 'Area Courts'),
  r('Assistant Chief Registrar I', 'Registry', 'Asst. Chief Reg. I'), r('Assistant Chief Registrar II', 'Registry', 'Asst. Chief Reg. II'),
  r('Principal Registrar I', 'Registry', 'Prin. Reg. I'), r('Principal Registrar II', 'Registry', 'Prin. Reg. II'),
  r('Senior Registrar I', 'Registry', 'Snr. Reg. I'), r('Senior Registrar II', 'Registry', 'Snr. Reg. II'),
  r('Higher Registrar', 'Registry'), r('Registrar', 'Registry'), r('Assistant Registrar', 'Registry', 'Asst. Registrar'),
  r('Administrative Officer', 'Administrative', 'Admin. Officer', 'Admin Officer'),
  r('Chief Executive Officer', 'Executive', 'C.E.O'), r('Principal Executive Officer I', 'Executive', 'P.E.O I'), r('Principal Executive Officer II', 'Executive', 'P.E.O II'),
  r('Senior Executive Officer', 'Executive', 'Snr. Exe. Officer', 'S.E.O'), r('Senior Executive Officer II', 'Executive', 'S.E.O II'),
  r('Higher Executive Officer', 'Executive', 'H.E.O', 'Higher Exe. Officer'), r('Executive Officer', 'Executive', 'Exe. Officer'),
  r('Assistant Executive Officer', 'Executive', 'A.E.O'),
  r('Chief Clerical Officer', 'Clerical', 'C.C.O'), r('Assistant Chief Clerical Officer', 'Clerical', 'A.C.C.O'),
  r('Senior Clerical Officer', 'Clerical', 'S.C.O'), r('Clerical Officer', 'Clerical', 'C.O', 'C/O'),
  r('Senior Court Clerk', 'Clerical', 'Snr. Court Clerk'), r('Court Clerk', 'Clerical'),
  r('Chief Typist', 'Typing and Computer'), r('Assistant Chief Typist', 'Typing and Computer'), r('Senior Typist', 'Typing and Computer', 'Snr. Typist'),
  r('Typist Grade I', 'Typing and Computer', 'Typist grd I'), r('Typist Grade II', 'Typing and Computer', 'Typist grd II'), r('Typist Grade III', 'Typing and Computer', 'Typist grd III'),
  r('Computer Operator', 'Typing and Computer', 'Comp. Operator'),
  r('Chief Bailiff', 'Bailiffs'), r('Assistant Chief Bailiff', 'Bailiffs', 'Asst. Chief Bailiff'), r('Senior Bailiff', 'Bailiffs', 'Snr. Bailiff'), r('Bailiff', 'Bailiffs'),
  r('Senior Store Officer', 'Stores', 'Snr. Store officer'), r('Store Officer', 'Stores'),
  r('Chief Driver', 'Drivers'), r('Senior Driver', 'Drivers', 'Snr. Driver'), r('Driver', 'Drivers'),
  r('Head Messenger', 'Messengers', 'H/Messenger'), r('Senior Messenger', 'Messengers', 'Snr. Messenger', 'S/Messenger'), r('Messenger', 'Messengers'),
  r('Head Watchman', 'Security', 'H/Watchman'), r('Senior Watchman', 'Security', 'Snr. Watchman'), r('Watchman', 'Security'),
  r('Head Cleaner', 'Cleaning', 'H/Cleaner'), r('Senior Cleaner', 'Cleaning', 'Snr. Cleaner'), r('Cleaner', 'Cleaning')
];
const DOC_TYPES = ['Appointment letter', 'Acceptance of offer', 'Assumption of duty', 'Confirmation letter', 'Promotion letter', 'Posting letter',
  'Certificate', 'Birth certificate or age declaration', 'Local government identification', 'Medical fitness', 'Query and reply', 'Others'];
const DEFAULTS = { stations: [], cadres: CADRES, ranks: RANKS, docTypes: DOC_TYPES };

async function getSettings() {
  const doc = await meta().findOne({ _id: KEY });
  const out = { ...DEFAULTS };
  if (doc) for (const k of Object.keys(DEFAULTS)) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

const clean = (v, max = 120) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
const list = (v, what) => { if (!Array.isArray(v)) throw bad(`Invalid list of ${what}.`); return v; };
const unique = (items, what) => {
  const seen = new Set();
  items.forEach(x => { const k = x.toLowerCase(); if (seen.has(k)) throw bad(`${x} is listed twice in the ${what}.`); seen.add(k); });
  return items;
};

async function setSettings(input) {
  const next = await getSettings();
  if (input.stations !== undefined) next.stations = unique(list(input.stations, 'stations').map(x => clean(x)).filter(Boolean), 'stations');
  if (input.cadres !== undefined) next.cadres = unique(list(input.cadres, 'cadres').map(x => clean(x, 60)).filter(Boolean), 'cadres');
  if (input.docTypes !== undefined) next.docTypes = unique(list(input.docTypes, 'document types').map(x => clean(x, 80)).filter(Boolean), 'document types');
  if (input.ranks !== undefined) {
    next.ranks = list(input.ranks, 'ranks').map(x => ({
      name: clean(x.name), cadre: clean(x.cadre, 60),
      aliases: (Array.isArray(x.aliases) ? x.aliases : String(x.aliases || '').split(',')).map(a => clean(a)).filter(Boolean)
    })).filter(x => x.name);
    unique(next.ranks.map(x => x.name), 'ranks');
  }
  await meta().updateOne({ _id: KEY }, { $set: next }, { upsert: true });
  return next;
}

// "S.C.O", "SCO" and "s c o" are written alike.
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function rankFinder(ranks) {
  const map = new Map();
  ranks.forEach(x => [x.name, ...(x.aliases || [])].forEach(a => { if (!map.has(key(a))) map.set(key(a), x); }));
  return (s) => map.get(key(s)) || null;
}
const lgaMap = new Map(LGAS.flatMap(([name, ...aliases]) => [name, ...aliases].map(a => [key(a), name])));
const findLga = (s) => lgaMap.get(key(s)) || '';
function readGl(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^cons/i.test(s)) return 'Cons.';
  const n = Number(s.replace(/^gl\s*/i, ''));
  return Number.isInteger(n) && n >= 1 && n <= 17 ? String(n).padStart(2, '0') : null;
}

module.exports = { getSettings, setSettings, rankFinder, findLga, readGl, key, LGAS: LGAS.map(x => x[0]), GLS, STATUS_LABELS, DEFAULTS };

/*
 * src/services/parties.js — changes to the parties and counsel of a case in
 * a court, recorded by its registry on the order of the court: a party
 * joined, a party struck out, counsel substituted. The filing stays as it
 * was; each change is kept in the case's partyLog with the date of the order.
 *
 * Each side keeps its parties one per line (as at filing). A party struck
 * out either stays in the title marked "(struck out)" or leaves it, as the
 * registry chooses. Email updates: a party joined, or new counsel, starts
 * receiving them; those of a party struck out or a counsel replaced stop,
 * unless the registry unticks that.
 */
const { DiaryEntry } = require('../models');
const caseEmail = require('./caseEmail');

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const SIDES = {
  first: { label: 'First party', party: 'firstParty', address: 'firstPartyAddress', emails: 'firstParty', counsel: 'counsel', counselAddress: 'counselAddress', counselEmails: 'counsel' },
  second: { label: 'Second party', party: 'secondParty', address: 'secondPartyAddress', emails: 'secondParty', counsel: 'counselSecond', counselAddress: 'counselSecondAddress', counselEmails: 'counselSecond' },
  third: { label: 'Third party', party: 'thirdParty', address: 'thirdPartyAddress', emails: 'thirdParty', counsel: 'counselThird', counselAddress: 'counselThirdAddress', counselEmails: 'counselThird' }
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STRUCK = ' (struck out)';
const lines = (s) => String(s || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
const text = (v, max) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);

function sideOf(key) {
  const s = SIDES[key];
  if (!s) throw bad('Choose the side: first party, second party or third party.');
  return s;
}
function orderDate(v) {
  if (v && !DAY.test(v)) throw bad('Enter the date of the order as a date.');
  if (v && v > today()) throw bad('The date of the order cannot be in the future.');
  return v || today();
}
const emailsOf = (c, key) => ((c.emails && c.emails[key]) || []).map(String);
function setEmails(c, key, list) {
  c.emails = { ...(c.emails && c.emails.toObject ? c.emails.toObject() : c.emails || {}), [key]: [...new Set(list.map(x => String(x).toLowerCase()))] };
}
// The emails of a party, from the log of joinders (the filing does not say whose is whose).
const partyEmails = (c, side, name) => (c.partyLog || []).filter(l => l.kind === 'join' && l.side === side && l.name === name).flatMap(l => l.emails || []);

// The diary's dates still to come show the parties and counsel as they now are.
const titleOf = (c) => [c.firstParty, c.secondParty].map(p => lines(p).join(', ')).filter(Boolean).join(' v. ');
async function refreshDiary(c) {
  await DiaryEntry.updateMany({ case: c._id, status: 'fixed', date: { $gte: today() } },
    { $set: { parties: titleOf(c), counsel: sideCounsel(c, 'first'), counselSecond: sideCounsel(c, 'second') } });
}

async function join(c, b, user) {
  const s = sideOf(b.side);
  const name = text(b.name, 200);
  if (!name) throw bad('Enter the name of the party joined.');
  if (lines(c[s.party]).some(l => l.replace(STRUCK, '').toLowerCase() === name.toLowerCase())) throw bad(`${name} is already a ${s.label.toLowerCase()}.`);
  const email = b.email ? caseEmail.cleanEmails(b.email, 'the party joined') : [];
  const address = text(b.address, 300);
  c[s.party] = [...lines(c[s.party]), name].join('\n');
  if (address) c[s.address] = [c[s.address], `${name}: ${address}`].filter(Boolean).join('\n');
  if (email.length) setEmails(c, s.emails, [...emailsOf(c, s.emails), ...email]);
  c.partyLog.push({ kind: 'join', side: b.side, name, address, emails: email, orderDate: orderDate(b.orderDate), note: text(b.note, 500), byName: user.fullName, at: new Date() });
  return `${name} joined as ${s.label.toLowerCase()}`;
}

async function strike(c, b, user) {
  const s = sideOf(b.side);
  const list = lines(c[s.party]);
  const i = list.findIndex(l => l === b.name);
  if (i < 0 || list[i].endsWith(STRUCK)) throw bad('Choose the party struck out.');
  const live = list.filter(l => !l.endsWith(STRUCK));
  if (live.length === 1 && b.side !== 'third') throw bad(`${b.name} is the only ${s.label.toLowerCase()} left. A case keeps at least one party on each side.`);
  const keep = b.keepInTitle !== false;
  if (keep) list[i] = list[i] + STRUCK; else list.splice(i, 1);
  c[s.party] = list.join('\n');
  const counselMails = (own(c, b.side, b.name) || { emails: [] }).emails.map(x => x.toLowerCase());
  const stop = (Array.isArray(b.stopEmails) ? b.stopEmails : []).map(x => String(x).toLowerCase())
    .filter(x => emailsOf(c, s.emails).map(e => e.toLowerCase()).includes(x) || counselMails.includes(x));
  if (stop.length) {
    setEmails(c, s.emails, emailsOf(c, s.emails).filter(x => !stop.includes(x.toLowerCase())));
    c.partyCounsel = (c.partyCounsel || []).map(x => x.side === b.side && x.party === b.name ? { ...(x.toObject ? x.toObject() : x), emails: (x.emails || []).filter(e => !stop.includes(e.toLowerCase())) } : x);
    c.markModified('partyCounsel');
  }
  c.partyLog.push({ kind: 'strike', side: b.side, name: b.name, orderDate: orderDate(b.orderDate), note: text(b.reason, 500), keepInTitle: keep, stoppedEmails: stop, byName: user.fullName, at: new Date() });
  return `${b.name} struck out as ${s.label.toLowerCase()}`;
}

// Counsel for a party: its own, where substituted; else the side's counsel.
const own = (c, side, party) => (c.partyCounsel || []).find(x => x.side === side && x.party === party);
function counselOf(c, side, party) {
  const s = SIDES[side], o = own(c, side, party);
  return o ? { name: o.name, address: o.address || '', emails: o.emails || [], own: true }
    : { name: c[s.counsel] || '', address: c[s.counselAddress] || '', emails: emailsOf(c, s.counselEmails), own: false };
}
const live = (c, side) => lines(c[SIDES[side].party]).filter(l => !l.endsWith(STRUCK));
// The counsel of a side for the diary and the cause list: one name, or each with their party.
function sideCounsel(c, side) {
  const list = live(c, side).map(p => ({ p, n: counselOf(c, side, p).name })).filter(x => x.n);
  const names = [...new Set(list.map(x => x.n))];
  return names.length <= 1 ? names[0] || '' : names.map(n => `${n} (for ${list.filter(x => x.n === n).map(x => x.p).join(', ')})`).join('; ');
}

// Counsel substituted for one party. The former counsel's updates stop
// (unless unticked), but not while they still act for another party.
async function substitute(c, b, user) {
  const s = sideOf(b.side);
  const party = String(b.party || '');
  if (!live(c, b.side).includes(party)) throw bad('Choose the party whose counsel changes.');
  const name = text(b.name, 200);
  if (!name) throw bad('Enter the name of the new counsel.');
  const before = counselOf(c, b.side, party);
  if (before.name.toLowerCase() === name.toLowerCase()) throw bad(`${name} is already counsel for ${party}.`);
  const email = b.email ? caseEmail.cleanEmails(b.email, 'the new counsel') : [];
  c.partyCounsel = [...(c.partyCounsel || []).filter(x => !(x.side === b.side && x.party === party)), { side: b.side, party, name, address: text(b.address, 300), emails: email }];
  let stopped = [];
  if (b.stopEmails !== false && before.emails.length) {
    // Addresses still used by counsel of any other party stay.
    const inUse = new Set(Object.keys(SIDES).flatMap(sd => live(c, sd).map(p => counselOf(c, sd, p))).flatMap(x => x.emails).map(x => x.toLowerCase()));
    stopped = before.emails.filter(x => !inUse.has(x.toLowerCase()));
    if (!before.own && stopped.length) setEmails(c, s.counselEmails, emailsOf(c, s.counselEmails).filter(x => !stopped.includes(x)));
  }
  c.partyLog.push({ kind: 'counsel', side: b.side, name, previous: before.name, address: text(b.address, 300), emails: email, orderDate: orderDate(b.date), note: text(b.note, 500),
    party, stoppedEmails: stopped, byName: user.fullName, at: new Date() });
  c.markModified('partyCounsel');
  return `${name} now counsel for ${party} (${s.label.toLowerCase()})${before.name ? `, in place of ${before.name}` : ''}`;
}

const ACTIONS = { join, strike, counsel: substitute };
async function apply(c, kind, body, user) {
  const fn = ACTIONS[kind];
  if (!fn) throw bad('Unknown change.');
  const what = await fn(c, body || {}, user);
  c.markModified('partyLog');
  await c.save();
  await refreshDiary(c);
  return what;
}

module.exports = { apply, partyEmails, lines, titleOf, counselOf, sideCounsel, SIDES, STRUCK };

/*
 * src/services/process.js — Process Registry settings, suit numbers and
 * the court rotation.
 *
 * Settings (kept in MongoDB, changed by an administrator): the number
 * prefix (GM), the case types with their letter (Civil none, Criminal c,
 * Petition p, ...), the schedule of filing fees, and which courts hear
 * EFCC matters; whether the receipt must be uploaded, and the payment
 * details printed on the invoice.
 *
 * Suit numbers: each case type counts on its own and starts again at 1
 * each year (GM/1/2026, GM/1c/2026, GM/1p/2026). The count is kept in
 * appmeta and taken with one atomic update, so two registrations can
 * never get the same number.
 *
 * Rotation: a new case is proposed for the court after the one proposed
 * last (after the last court, back to the first). EFCC matters go round
 * the EFCC courts only. The Chief Judge may assign another court; the
 * rotation still continues from the court proposed.
 */
const mongoose = require('mongoose');
const { Unit } = require('../models');

const KEY = 'processSettings';
const DEFAULTS = {
  prefix: 'GM',
  // book: which of the court's two register books the case goes in.
  caseTypes: [
    { key: 'civil', label: 'Civil', suffix: '', book: 'civil' },
    { key: 'criminal', label: 'Criminal', suffix: 'c', book: 'criminal' },
    { key: 'petition', label: 'Petition', suffix: 'p', book: 'civil' }
  ],
  // [{ group: '9. Filing of court processes', item: '9(a)(i) Writ of summons', amount: 4000 }]
  // or a percentage worked out on an amount the filer gives: { item, percent: 2 }
  fees: [],
  feeSource: null,   // { key, name, at, by } when the official schedule was loaded
  efccCourts: [],    // unit keys of the courts that hear EFCC matters
  receiptRequired: true, // the receipt file must be uploaded before registration
  paymentNote: '',   // printed on the invoice: where and how to pay
  partyEmails: true, // email the parties and counsel at each stage (where addresses were given)
  // The business of a sitting, for the court diary (Others is always offered too).
  businessTypes: ['Mention', 'Hearing', 'Continuation of hearing', 'Ruling', 'Judgment', 'Report of service'],
  dailyLimit: 0      // most cases in a court's diary on one day; 0: no limit
};
const REMARKS = ['Judgment entered', 'Struck out', 'Withdrawn', 'Dismissed', 'Transferred'];

const meta = () => mongoose.connection.collection('appmeta');

// A type saved before books existed: criminal ones (letter c) go in the
// Criminal book, the rest in the Civil book.
const bookOf = (t) => (t.book === 'criminal' || t.book === 'civil') ? t.book : (t.suffix === 'c' || t.key === 'criminal' ? 'criminal' : 'civil');

async function getSettings() {
  const doc = await meta().findOne({ _id: KEY });
  const out = { ...DEFAULTS };
  if (doc) for (const k of Object.keys(DEFAULTS)) if (doc[k] !== undefined) out[k] = doc[k];
  out.caseTypes = out.caseTypes.map(t => ({ ...t, book: bookOf(t) }));
  return out;
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

// Checked and tidied before saving; a case type in use keeps its key.
async function setSettings(input) {
  const cur = await getSettings();
  const next = { ...cur };
  if (input.prefix !== undefined) {
    next.prefix = String(input.prefix).trim().toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(next.prefix)) throw bad('The number prefix must be 1 to 6 letters, for example GM.');
  }
  if (input.caseTypes !== undefined) {
    if (!Array.isArray(input.caseTypes) || !input.caseTypes.length) throw bad('Keep at least one case type.');
    const seen = new Set();
    next.caseTypes = input.caseTypes.map(t => {
      const label = String(t.label || '').trim().slice(0, 40);
      const suffix = String(t.suffix || '').trim().toLowerCase();
      if (!label) throw bad('Every case type needs a name.');
      if (!/^[a-z]{0,3}$/.test(suffix)) throw bad(`The letter for ${label} must be up to 3 letters (or none).`);
      if (seen.has(suffix)) throw bad(`Two case types use the same letter "${suffix || 'none'}". Each needs its own, so their numbers never clash.`);
      seen.add(suffix);
      const key = String(t.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
      return { key, label, suffix, book: bookOf({ key, suffix, book: t.book }) };
    });
  }
  if (input.fees !== undefined) {
    if (!Array.isArray(input.fees)) throw bad('Invalid fee schedule.');
    const seen = new Set();
    next.fees = input.fees.map(f => {
      const item = String(f.item || '').trim().slice(0, 200);
      const group = String(f.group || '').trim().slice(0, 120);
      if (!item) throw bad('Every fee needs a name.');
      if (seen.has(item)) throw bad(`The fee "${item}" is listed twice. Each fee needs its own name.`);
      seen.add(item);
      if (f.percent !== undefined && f.percent !== '' && f.percent !== null) {
        const percent = Number(f.percent);
        if (!(percent > 0) || percent > 100) throw bad(`Enter a percentage between 0 and 100 for ${item}.`);
        return { group, item, percent: Math.round(percent * 1000) / 1000 };
      }
      const amount = Number(f.amount);
      if (f.amount === '' || f.amount === undefined || !(amount >= 0) || amount > 1e9) throw bad(`Enter a valid amount (or a percentage) for ${item}.`);
      return { group, item, amount: Math.round(amount * 100) / 100 };
    });
  }
  if (input.efccCourts !== undefined) {
    const courts = new Set((await courts_()).map(c => c.key));
    next.efccCourts = [...new Set((input.efccCourts || []).map(String))].filter(k => courts.has(k));
  }
  if (input.receiptRequired !== undefined) next.receiptRequired = !!input.receiptRequired;
  if (input.partyEmails !== undefined) next.partyEmails = !!input.partyEmails;
  if (input.businessTypes !== undefined) {
    if (!Array.isArray(input.businessTypes)) throw bad('Invalid list of business.');
    next.businessTypes = [...new Set(input.businessTypes.map(b => String(b || '').trim().slice(0, 60)).filter(b => b && b.toLowerCase() !== 'others'))];
    if (!next.businessTypes.length) throw bad('Keep at least one kind of business for the diary.');
  }
  if (input.dailyLimit !== undefined) {
    const n = parseInt(input.dailyLimit, 10) || 0;
    if (n < 0 || n > 500) throw bad('The daily limit must be between 0 (no limit) and 500.');
    next.dailyLimit = n;
  }
  if (input.paymentNote !== undefined) next.paymentNote = String(input.paymentNote || '').trim().slice(0, 1000);
  await meta().updateOne({ _id: KEY }, { $set: next }, { upsert: true });
  return next;
}

// The official schedule of court fees (Legal Notice No. 1 of 2023) into the
// fee list. The list it replaces is kept in appmeta, so nothing is lost.
async function loadOfficialFees(by) {
  const official = require('../forms/feeSchedule2023');
  const cur = await getSettings();
  await meta().updateOne({ _id: `feesBefore:${official.KEY}` }, { $set: { fees: cur.fees, at: new Date(), by } }, { upsert: true });
  const feeSource = { key: official.KEY, name: official.SOURCE, at: new Date(), by };
  await meta().updateOne({ _id: KEY }, { $set: { fees: official.FEES.map(f => ({ ...f })), feeSource } }, { upsert: true });
  return { fees: official.FEES.length, feeSource };
}

// On the first start after the schedule was added, load it once by itself.
// After that the list in Settings is the one used, corrections and all.
async function loadOfficialFeesOnce(log = console.log) {
  const official = require('../forms/feeSchedule2023');
  const flag = `officialFeesLoaded:${official.KEY}`;
  try { await meta().insertOne({ _id: flag, at: new Date() }); }
  catch (e) { if (e.code === 11000) return false; throw e; }
  const r = await loadOfficialFees('system');
  log(`Court fees: loaded the ${r.fees} fees of ${official.SOURCE}.`);
  return true;
}

// The courts that take new cases, in order: active court registries by number.
async function courts_() {
  return (await Unit.find({ type: 'registry', active: true }).lean()).sort((a, b) => (a.courtNo || 0) - (b.courtNo || 0));
}

// "GM/45c/2026" for display with the letter raised: "GM/45<sup>c</sup>/2026".
function formatHtml(suitNumber, esc = (s) => s) {
  const m = /^(.*\/\d+)([a-z]+)(\/\d{4})$/i.exec(String(suitNumber || ''));
  return m ? `${esc(m[1])}<sup>${esc(m[2].toLowerCase())}</sup>${esc(m[3])}` : esc(String(suitNumber || ''));
}

// The next suit number for a case type this year.
async function nextNumber(caseType, now = new Date()) {
  const s = await getSettings();
  const type = s.caseTypes.find(t => t.key === caseType);
  if (!type) throw bad('Unknown case type.');
  const year = now.getFullYear();
  const r = await meta().findOneAndUpdate({ _id: `caseSeq:${caseType}:${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  const seq = (r && r.value ? r.value : r).seq;
  return { seq, year, suitNumber: `${s.prefix}/${seq}${type.suffix}/${year}` };
}

// The next invoice reference: INV/2026/0001, from 1 again each year.
async function nextInvoice(now = new Date()) {
  const year = now.getFullYear();
  const r = await meta().findOneAndUpdate({ _id: `invoiceSeq:${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  const seq = (r && r.value ? r.value : r).seq;
  return `INV/${year}/${String(seq).padStart(4, '0')}`;
}

// Propose the next court in turn, and move the rotation on to it.
async function proposeCourt(efcc) {
  const all = await courts_();
  const s = await getSettings();
  const ring = efcc ? all.filter(c => s.efccCourts.includes(c.key)) : all;
  if (!ring.length) throw bad(efcc ? 'No court is set to hear EFCC matters. An administrator sets them in Settings, Process Registry.' : 'There is no active court registry to assign cases to.');
  const id = efcc ? 'rotation:efcc' : 'rotation:ordinary';
  for (let tries = 0; tries < 10; tries++) {
    const cur = await meta().findOne({ _id: id });
    const last = cur ? cur.unitKey : null;
    const i = ring.findIndex(c => c.key === last);
    const next = ring[(i + 1) % ring.length]; // after the last one (or the first if none yet)
    const filter = cur ? { _id: id, unitKey: last } : { _id: id, unitKey: { $exists: false } };
    try {
      const r = await meta().updateOne(filter, { $set: { unitKey: next.key, at: new Date() } }, { upsert: !cur });
      if (r.modifiedCount || r.upsertedCount) return next;
    } catch (e) { if (e.code !== 11000) throw e; }
    // another registration moved the rotation at the same moment: try again
  }
  throw new Error('The court rotation is busy. Please try again.');
}

async function rotationState() {
  const [o, e] = await Promise.all([meta().findOne({ _id: 'rotation:ordinary' }), meta().findOne({ _id: 'rotation:efcc' })]);
  return { ordinaryLast: o ? o.unitKey : null, efccLast: e ? e.unitKey : null };
}

// "IX" for 9: courts are named in Roman figures on the slip.
function roman(n) {
  const v = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '', x = parseInt(n, 10) || 0;
  for (const [k, r] of v) while (x >= k) { s += r; x -= k; }
  return s;
}

module.exports = { getSettings, setSettings, loadOfficialFees, loadOfficialFeesOnce, nextNumber, nextInvoice, proposeCourt, rotationState, courts: courts_, formatHtml, roman, REMARKS, DEFAULTS };

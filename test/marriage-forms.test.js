/*
 * The Marriage Registry forms as printed: the slips on the paper forms
 * corrected (the vows, the prohibited degrees).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: { App: {} }, document: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'core', 'output.js'), 'utf8'), sandbox);
const render = (formType, data) => sandbox.window.App.output.render({ formType, data, status: 'final', createdAt: '2026-11-10T09:00:00Z' }, 'Marriage Registry');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#039;/g, "'").replace(/\s+/g, ' ');

test('the vows: "all persons present" for both, no stray quotation mark, no "(Claps)"', () => {
  const t = text(render('marriage-oath-taking', { groomName: 'Musa Bello', brideName: 'Aisha Ahmed' }));
  assert.equal((t.match(/call upon all persons present/g) || []).length, 2);
  assert.ok(!/all person present/.test(t));
  assert.ok(!/Claps/.test(t));
  assert.ok(!/"/.test(t.replace(/&quot;/g, '"').replace(/class="[^"]*"/g, '')), 'no stray quotation mark');
  assert.match(t, /to have and to hold from this moment/);
  assert.equal((t.match(/do us part\. Amen\./g) || []).length, 2);
});

test('the prohibited degrees: no entry twice in a column, none run together', () => {
  const html = render('prohibited-degrees', { husbandName: 'Musa Bello', wifeName: 'Aisha Ahmed' });
  const rows = [...html.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map(m => [m[1], m[2]].map(x => x.replace(/&#039;/g, "'")));
  const man = rows.map(r => r[0]), woman = rows.map(r => r[1]);
  assert.equal(new Set(man).size, man.length, 'a man\'s column with no repeats');
  assert.equal(new Set(woman.map(w => w.toLowerCase())).size, woman.length, 'a woman\'s column with no repeats');
  assert.ok(man.includes("Mother's mother") && man.includes("Wife's son's daughter") && man.includes("Father's father's wife"));
  assert.ok(woman.includes("Son's Daughter's Husband") && woman.includes("Father's brother"));
  assert.ok(!woman.some(w => /wife's father/i.test(w)));
});

test('the notice of marriage shows its expiry; the ring oaths are one for the groom and one for the bride', () => {
  const t = text(render('notice-of-marriage', { registrarDistrict: 'Gombe', marriagePlace: 'the Marriage Registry, Gombe', noticeDate: '2026-11-11', expiryDate: '2027-02-11', caveatEnds: '2026-12-02', marriageFrom: '2026-12-03',
    husbandName: 'Musa Bello', wifeName: 'Aisha Ahmed' }));
  assert.match(t, /NOTICE OF MARRIAGE/);
  assert.match(t, /Caveat period ends 2nd December 2026/);
  assert.match(t, /Marriage may hold from 3rd December 2026/);
  assert.match(t, /Notice expires on 11th February 2027/);
  assert.match(t, /Witness my hand this 11th day of November 20 ?26/);
  const o = text(render('marriage-oath-affirmation', { groomName: 'Musa Bello', brideName: 'Aisha Ahmed', ringOathWith: 'RING', brideRingWith: "QUR'AN" }));
  assert.match(o, /I Musa Bello \(HUSBAND\) WITH THIS RING I WED YOU Aisha Ahmed \(WIFE\)/);
  assert.match(o, /I Aisha Ahmed \(WIFE\) WITH THIS QUR'AN I WED YOU Musa Bello \(HUSBAND\)/);
  assert.equal((o.match(/Groom Signature/g) || []).length, 2, 'the groom signs the affirmation and his ring oath');
  assert.equal((o.match(/Bride Signature/g) || []).length, 2);
});

test('where a notice stands: caveat period to day 21, may hold from day 22 to the expiry, then expired', () => {
  const { listNote } = require('../src/forms/catalogue');
  const at = (day) => listNote('notice-of-marriage', { noticeDate: '2026-11-11' }, day);
  assert.equal(at('2026-12-02').tone, 'pending', 'the 21st day is still in the caveat period');
  assert.match(at('2026-12-03').text, /Marriage may hold, 3 Dec 2026 to 11 Feb 2027/);
  assert.equal(at('2027-02-11').tone, 'final', 'the last day of the three months');
  assert.match(at('2027-02-12').text, /Expired 11 Feb 2027: a new notice is needed/);
  assert.equal(listNote('marriage-particulars', { noticeDate: '2026-11-11' }), null, 'only for the notice');
});

test('a caveat holds the marriage; upheld it stops it; withdrawn or removed it lets it go ahead', () => {
  const { listNote } = require('../src/forms/catalogue');
  const at = (day, caveats) => listNote('notice-of-marriage', { noticeDate: '2026-11-11' }, day, caveats);
  assert.match(at('2026-11-20', [{ status: 'open' }]).text, /Caveat entered: marriage on hold/);
  assert.match(at('2026-12-10', [{ status: 'open' }]).text, /on hold/, 'still held after the 21 days while it is open');
  assert.match(at('2026-12-10', [{ status: 'removed' }, { status: 'withdrawn' }]).text, /Marriage may hold/);
  assert.match(at('2026-12-10', [{ status: 'upheld' }]).text, /Caveat upheld: the marriage cannot hold/);
  assert.match(at('2027-03-01', [{ status: 'open' }]).text, /Expired/, 'an expired notice needs a new one either way');
});

test('a notice saved before the caveat dates were kept still prints them, from its date', () => {
  const t = text(render('notice-of-marriage', { noticeDate: '2026-11-11', husbandName: 'A', wifeName: 'B' }));
  assert.match(t, /Caveat period ends 2nd December 2026/);
  assert.match(t, /Marriage may hold from 3rd December 2026/);
  assert.match(t, /Notice expires on 11th February 2027/);
});

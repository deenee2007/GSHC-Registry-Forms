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
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

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

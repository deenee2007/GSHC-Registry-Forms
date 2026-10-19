/*
 * Fixes found in the review of all forms: dates on the Court Order, Cause
 * List and execution Affidavit of Service, and the Writ of Attachment and
 * Sale of Goods wording. Renders the print templates directly.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public', 'js');
const sb = { window: { App: {} } };
vm.createContext(sb);
['modules/registry.js', 'modules/execution.js', 'core/output.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(PUB, f), 'utf8'), sb));
const { output, allForms } = sb.window.App;
const text = (formType, data) => output.render({ formType, status: 'final', data, signatures: [] }, 'Unit', allForms[formType])
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

test('Court Order prints the weekday, month and year of the sitting and of the date given', () => {
  const t = text('court-order', { sittingDate: '2026-10-16', issueDate: '2026-11-03', processDate: '2026-09-01', filingDate: '2026-09-02', processType: 'motion-on-notice' });
  assert.match(t, /ON FRIDAY THE 16TH DAY OF OCTOBER, 2026/);
  assert.match(t, /DATED THE 3RD DAY OF NOVEMBER 2026/);
  assert.match(t, /dated 1\/9\/2026 filed on the 2\/9\/2026/);
});

test('Cause List prints a readable date', () => {
  assert.match(text('cause-list', { sittingDate: '2026-10-16', entries: [] }), /DATE: 16 October 2026/);
});

test('execution Affidavit of Service: readable date, no repeated name, no "This this"', () => {
  const t = text('ex-affidavit-of-service', { processDate: '2026-10-01', swornDate: '2026-10-16', unknownPerson: 'Ali Sani' });
  assert.match(t, /dated 1 October 2026/);
  assert.match(t, /Before the day I served the process, I did not know Ali Sani personally/);
  assert.doesNotMatch(t, /This this/i);
});

test('Writ of Attachment and Sale of Goods: corrected phrases', () => {
  const t = text('writ-attachment-goods', { judgmentDate: '2026-08-01', defaultDate: '2026-09-01' });
  assert.match(t, /WHEREAS on the 1 day of August/);
  assert.doesNotMatch(t, /on the this/);
  assert.match(t, /upon the application of the Plaintiff it was/);
  assert.match(t, /seizing and taking any money/);
});

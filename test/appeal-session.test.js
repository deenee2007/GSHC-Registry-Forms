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
const render = (formType, data, unit) => sandbox.window.App.output.render({ formType, data, status: 'final', createdAt: '2026-11-10T09:00:00Z' }, unit || 'Appeals Registry');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#039;/g, "'").replace(/\s+/g, ' ');


const { get } = require('../src/forms/catalogue');

test('every appeal form names its appeal session, holden at its town, under the court line', () => {
  for (const f of ['summons-settle-record', 'notice-appeal-fixed', 'criminal-appeal-notice', 'civil-appeal-notice']) {
    const field = get(f).schema.find(x => x.name === 'appealSession');
    assert.ok(field && field.required, `${f} asks for the session`);
    assert.deepEqual(field.options.map(o => o.value), ['Gombe', 'Dukku', 'Kaltungo']);
    const t = text(render(f, { appealSession: 'Dukku', appellant: 'A', respondent: 'B' }));
    assert.match(t, /IN THE HIGH COURT OF GOMBE STATE IN THE DUKKU APPEAL SESSION HOLDEN AT DUKKU/, f);
    assert.doesNotMatch(t, /JUDICIAL DIVISION/i, f);
    assert.match(text(render(f, { appellant: 'A' })), /IN THE GOMBE APPEAL SESSION HOLDEN AT GOMBE/, `${f}: an older record prints Gombe`);
  }
});

test('Court Registry forms: the judicial division, or the appeal session when the court sits on an appeal', () => {
  const forms = ['civil-summons', 'criminal-summons', 'warrant-of-arrest', 'affidavit-of-service', 'subpoena-ad-testificandum', 'subpoena-duces-tecum', 'cause-list', 'court-order'];
  for (const f of forms) {
    assert.ok(get(f).schema.some(x => x.name === 'appealSession'), `${f} has Sitting as`);
    const div = text(render(f, {}, 'High Court 1 Registry'));
    assert.match(div, /JUDICIAL DIVISION/, `${f}: division by default`);
    const ap = text(render(f, { appealSession: 'Kaltungo' }, 'High Court 1 Registry'));
    assert.match(ap, /IN THE HIGH COURT OF GOMBE STATE IN THE KALTUNGO APPEAL SESSION HOLDEN AT KALTUNGO/, f);
    assert.doesNotMatch(ap, /IN THE GOMBE JUDICIAL DIVISION/, f);
  }
  assert.doesNotMatch(text(render('hearing-notice', {}, 'High Court 1 Registry')), /APPEAL SESSION/);
  assert.match(text(render('hearing-notice', { appealSession: 'Gombe' }, 'High Court 1 Registry')), /IN THE GOMBE APPEAL SESSION HOLDEN AT GOMBE/);
});

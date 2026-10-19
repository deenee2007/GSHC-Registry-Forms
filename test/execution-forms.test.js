/*
 * Wording of the execution forms, as corrected by the Execution / Bailiffs
 * Unit. Renders the print templates directly (no database needed).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public', 'js');
const sb = { window: { App: {} } };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(PUB, 'modules', 'execution.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(PUB, 'core', 'output.js'), 'utf8'), sb);
const { output, allForms } = sb.window.App;

// Fill defaults the way a new form does, then render as plain text.
function text(formType, data) {
  const d = {};
  allForms[formType].schema.forEach(f => { if (f.name && f.defaultValue !== undefined) d[f.name] = f.defaultValue; });
  const html = output.render({ formType, status: 'final', data: { ...d, ...data }, signatures: [] }, 'Execution / Bailiffs Unit', allForms[formType]);
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

test('police request: address and subject', () => {
  const t = text('request-police-assistance', { personnelCount: 'Five', suitTitle: 'A v. B', suitNumber: 'GM/1/2026' });
  assert.match(t, /The Commissioner of Police, Gombe State Command, Headquarters, Gombe State\./);
  assert.match(t, /REQUEST FOR FIVE PERSONNEL: A v\. B/);
  assert.doesNotMatch(t, /POLICE PERSONNEL ASSISTANCE/);
  assert.match(text('request-police-assistance', { suitTitle: 'A v. B' }), /REQUEST FOR PERSONNEL: A v\. B/, 'count is optional');
});

test('NSCDC request: official name and subject', () => {
  const t = text('request-nscdc-personnel', { personnelCount: 'Three', suitTitle: 'A v. B' });
  assert.match(t, /The Commandant, Nigeria Security and Civil Defence Corps, Gombe State Command\./);
  assert.match(t, /REQUEST FOR THREE PERSONNEL: A v\. B/);
  assert.doesNotMatch(t, /WITH ARMS/);
});

test('statutory notice heading names movable/immovable; the choice stays in the body', () => {
  const t = text('statutory-notice-auction', { suitTitle: 'A v. B', propertyCategory: 'movable' });
  assert.match(t, /STATUTORY NOTICE FOR PUBLIC AUCTION \(MOVABLE\/IMMOVABLE\): A v\. B/);
  assert.match(t, /your movable property was attached/);
});

test('custody writ: title, Judgment Creditor / Judgment Debtor, entitled party selectable', () => {
  let t = text('writ-possession-children', { plaintiff: 'Hauwa', defendant: 'Sani' });
  assert.match(t, /WRIT OF POSSESSION OF CUSTODY OF CHILD\/CHILDREN/);
  assert.match(t, /Hauwa …… Judgment Creditor/);
  assert.match(t, /Sani …… Judgment Debtor/);
  assert.match(t, /adjudged that the Judgment Creditor is entitled to possession/);
  assert.match(t, /the Judgment Debtor to wit/);
  t = text('writ-possession-children', { plaintiff: 'Hauwa', defendant: 'Sani', entitledParty: 'debtor' });
  assert.match(t, /adjudged that the Judgment Debtor is entitled to possession/);
  t = text('writ-possession-children', { plaintiff: 'Hauwa', defendant: 'Sani', partyTerms: 'suit' });
  assert.match(t, /Hauwa …… Plaintiff/);
  assert.match(t, /adjudged that the Plaintiff is entitled/);
});

test('writ of attachment and sale of goods: corrected paragraph, no doubled "Judicial Division"', () => {
  const t = text('writ-attachment-goods', { creditorName: 'Musa', debtorName: 'Ali' });
  assert.match(t, /amount due to the Musa \(Judgment Creditor\) under the said judgment\/order together with the cost of the writ and the cost of executing the same/);
  assert.match(t, /goods and chattels of the Ali \(Judgment Debtor\) wheresoever they may be found within the Gombe Judicial Division \(except the wearing apparel/);
  assert.doesNotMatch(t, /Judicial Division Judicial Division/);
  const old = text('writ-attachment-goods', { judicialDivision: 'Gombe Judicial Division' });
  assert.doesNotMatch(old, /Judicial Division Judicial Division/, 'older drafts holding the full phrase print it once');
});

test('public auction receipt heading', () => {
  assert.match(text('public-auction-receipt', {}), /HIGH COURT PUBLIC AUCTION RECEIPT/);
});

test('public auction receipt: Chief Bailiff and Deputy Sheriff (Director of Litigation) on top, Chief Registrar below', () => {
  const html = output.render({ formType: 'public-auction-receipt', status: 'final', data: { chiefBailiffName: 'Ibrahim', deputySheriffName: 'Aminu' },
    signatures: [
      { role: 'chief_registrar', label: 'Chief Registrar', name: 'Fatima Bello', imageUrl: 'data:image/png;base64,AA', signedAt: new Date() },
      { role: 'deputy_sheriff', label: 'Deputy Sheriff', name: 'Yusuf Ali', imageUrl: 'data:image/png;base64,AA', signedAt: new Date() }
    ] }, 'Execution / Bailiffs Unit', allForms['public-auction-receipt']);
  const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(t, /CHIEF BAILIFF Ibrahim .*DEPUTY SHERIFF \(Director of Litigation\) Yusuf Ali .*CHIEF REGISTRAR Fatima Bello/, 'in this order');
  assert.equal((html.match(/doc-sign-block/g) || []).length, 3, 'three signature lines');
  assert.doesNotMatch(t, /DIRECTOR OF LITIGATION/, 'no separate Director of Litigation line');
  assert.doesNotMatch(html, /doc-esign/, 'no signature left over below the receipt');
});

test('writ of goods: division and High Court number on the line after the title', () => {
  const line = (data) => (text('writ-attachment-goods', data).match(/In the High Court of Justice of the .*?(?= BETWEEN)/) || [''])[0].replace(/\s+/g, ' ').trim();
  assert.equal(line({ courtNumber: '9' }), 'In the High Court of Justice of the Gombe Judicial Division, High Court No. 9 .');
  assert.equal(line({ courtNumber: 'High Court No. 4' }), 'In the High Court of Justice of the Gombe Judicial Division, High Court No. 4 .', 'no doubled words');
  assert.equal(line({}), 'In the High Court of Justice of the Gombe Judicial Division.', 'number optional');
  assert.equal(line({ judicialDivision: 'No. 9' }), 'In the High Court of Justice of the Gombe Judicial Division, High Court No. 9 .', 'older drafts with the number in the division box');
  assert.match(text('writ-attachment-goods', { judicialDivision: 'No. 9', debtorName: 'Ali' }), /found within the Gombe Judicial Division/);
});

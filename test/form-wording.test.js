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
['modules/registry.js', 'modules/appeals.js', 'modules/execution.js', 'core/output.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(PUB, f), 'utf8'), sb));
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
  assert.match(t, /WHEREAS on the 1st day of August 2026/);
  assert.doesNotMatch(t, /on the this/);
  assert.match(t, /upon the application of the Plaintiff it was/);
  assert.match(t, /seizing and taking any money/);
});

/* ---- second round of corrections ---------------------------------------- */

test('registry forms: subpoena name and heading, affidavit of means, warrants, bail bond', () => {
  assert.equal(allForms['subpoena-ad-testificandum'].label, 'Subpoena ad Testificandum');
  assert.match(text('subpoena-ad-testificandum', {}), /FORM 40 IN THE GOMBE JUDICIAL DIVISION HOLDEN AT GOMBE/);
  const m = text('affidavit-of-means', { receiptDate: '2026-10-16' });
  assert.equal(m.match(/AFFIDAVIT OF MEANS/g).length, 1);
  assert.match(m, /Date: 16 October 2026/);
  assert.match(text('warrant-of-arrest', {}), /bring him\/her before/);
  assert.match(text('remand-warrant', {}), /JUDICIAL \(GMS\) FORM 25/);
  assert.doesNotMatch(text('committal-warrant', {}), /\(\s*\)|reduced/);
  assert.match(text('committal-warrant', { reducedTerm: '2 months' }), /sentence of imprisonment, reduced to a term of 2 months on account of part payment/);
  const b = text('bail-bond', { accusedName: 'Ali', suretyName: 'Musa' });
  assert.match(b, /accused of the offence of .*, and being required to give security/);
  assert.match(b, /I, Musa of .* hereby declare myself surety for the said Ali that he\/she shall attend/);
});

test('Notice of Appeal Fixed: corrected wording and one date field', () => {
  const t = text('notice-appeal-fixed', { hearingDate: '2026-11-15', originalDecisionDate: '2026-09-01', depositAmount: '100' });
  assert.match(t, /fixed in this Hon\. Court on the 15th day of November 2026/);
  assert.match(t, /decision of your Court on 1\/9\/2026/);
  assert.match(t, /file two copies of the Notice of Appeal/);
  assert.match(t, /Form 2 of the First Schedule to the Gombe State High Court \(Appeal from Area Court Rules 1960\)/);
  assert.match(t, /he\/she is required to deposit in your Court at the same time/);
  assert.match(t, /Rule 4\(3\) of Order II/);
  assert.match(t, /Please comply with the instructions in the above paragraphs without delay/);
  assert.doesNotMatch(t, /copy\(s\)|Now Area|Notice of Appeals|first scheduled/);
  const old = text('notice-appeal-fixed', { hearingDay: '15th', hearingMonth: 'November', hearingYear: '2026' });
  assert.match(old, /on the 15th day of November 2026/, 'older drafts still print');
});

test('appeal notices and summons to settle record', () => {
  const t = text('criminal-appeal-notice', { appellant: 'Ali', dateOfDecision: '2026-09-01' });
  assert.match(t, /NOTICE OF CRIMINAL APPEAL/);
  assert.match(t, /1\. Date of Decision: 1 September 2026 2\./);
  assert.match(t, /upon receipt of the record of proceedings/);
  assert.match(text('civil-appeal-notice', {}), /NOTICE OF CIVIL APPEAL/);
  assert.match(text('summons-settle-record', {}), /Dated at/);
});

test('execution Affidavit of Service wording', () => {
  const t = text('ex-affidavit-of-service', { swornAt: 'High Court Registry, Gombe', complaintOf: 'Musa' });
  assert.match(t, /I served upon/);
  assert.match(t, /a true copy whereof is hereunto annexed, issued out of this Court/);
  assert.match(t, /upon the complaint\/application of Musa/);
  assert.match(t, /if he\/she was/);
  assert.match(t, /Sworn to at High Court Registry, Gombe This/);
  assert.match(t, /Before me Commissioner for Oaths/);
});

test('Writ of Attachment and Sale (Immovable): judgment sum and corrected phrases', () => {
  const t = text('writ-attachment-immovable', { judgmentSum: '500,000', installmentAmount: '50,000', installmentPeriod: 'month' });
  assert.match(t, /for the payment of N ?500,000 by instalments of N ?50,000 for every month ?\./);
  assert.match(t, /in pursuance of the said Judgment/);
  assert.match(t, /wheresoever such property may be found/);
  assert.doesNotMatch(text('writ-attachment-immovable', { judgmentSum: '500,000' }), /instalments/);
});

test('Writ of Possession of Property: party terms and entitled party', () => {
  let t = text('writ-possession-property', { partyTerms: 'judgment', entitledParty: 'first', appellant: 'Musa', respondent: 'Ali', houseScheme: 'Federal Low Cost' });
  assert.match(t, /Musa …… Judgment Creditor/);
  assert.match(t, /adjudged that the Judgment Creditor is entitled/);
  assert.match(t, /The Judgment Debtor and\/or his\/her tenant/);
  assert.match(t, /Federal Low Cost House Scheme, and it was ordered/);
  assert.match(t, /give possession of the said property to the Judgment Creditor/);
  assert.doesNotMatch(t, /Plaintiff|premises/);
  t = text('writ-possession-property', { appellant: 'Musa', respondent: 'Ali' });
  assert.match(t, /adjudged that the Respondent is entitled/, 'older drafts keep their meaning');
  assert.match(t, /The Appellant and\/or his\/her tenant/);
});

test('Writ of Possession of Premises: one party named, not both', () => {
  const t = text('writ-possession-premises', { partyTerms: 'judgment', entitledParty: 'creditor', propertyType: 'House' });
  assert.match(t, /The Judgment Debtor and\/or his\/her tenant \(in occupation\) be ejected from the said house/);
  assert.match(t, /AND WHEREAS THE JUDGMENT DEBTOR TO WIT/);
  assert.match(t, /Holden at/);
  assert.doesNotMatch(t, /creditor\/judgment debtor/i);
});

test('Writ of Possession of Certificate of Occupancy', () => {
  const t = text('writ-possession-occupancy', { partyTerms: 'judgment', plaintiff: 'Musa' });
  assert.match(t, /IN THE GOMBE JUDICIAL DIVISION/);
  assert.match(t, /Musa …… Judgment Creditor/);
  assert.match(t, /Court Holden at Gombe/);
  assert.equal(t.match(/Certificate of Occupancy/gi).length, 4);
  assert.match(text('writ-possession-occupancy', { partyTerms: 'suit' }), /adjudged that the Plaintiff is entitled/);
});

test('Notice of Attachment, Judgment Summons, Statutory Notice', () => {
  const t = text('notice-of-attachment', {});
  assert.equal(t.match(/NOTICE OF ATTACHMENT/g).length, 1);
  assert.match(t, /and the amount for which it has been issued/);
  assert.match(t, /Otherwise, you may be liable to pay the Sheriff a fee of Two kobo daily/);
  assert.match(t, /if any, of feeding animals/);
  assert.match(text('notice-of-attachment', { possessionFee: '₦500' }), /a fee of ₦500 daily/);
  assert.match(text('judgment-summons', {}), /\(PRAECIPE\)/);
  assert.match(text('statutory-notice-auction', { noticeDays: '7' }), /If you fail to do so within the said 7 days, your property shall be sold/);
});

test('personnel letters, notice to vacate, writ of goods', () => {
  const p = text('request-police-assistance', {});
  assert.match(p, /to enable our office to enforce/);
  assert.match(p, /Attached herewith is a copy of the Court Orders/);
  assert.match(text('request-nscdc-personnel', {}), /Attached herewith is a writ of fi\. fa\. and the Court Order/);
  const v = text('notice-to-vacate', {});
  assert.match(v, /which you failed to pay/);
  assert.match(v, /forcible ejection/);
  const g = text('writ-attachment-goods', { debtorName: 'Ali' });
  assert.match(g, /belonging to the Ali which may be found there, or such part/);
  assert.match(g, /to the value of five pounds ?\)/);
  assert.match(text('writ-attachment-goods', { exemptValue: '₦50,000' }), /to the value of ₦50,000 ?\)/);
});

/* ---- dates ---------------------------------------------------------------- */

test('dates print as "the 1st day of October 2026" on every form', () => {
  const cases = [['2026-10-01', '1st'], ['2026-10-02', '2nd'], ['2026-10-03', '3rd'], ['2026-10-11', '11th'], ['2026-10-12', '12th'], ['2026-10-13', '13th'], ['2026-10-21', '21st'], ['2026-10-22', '22nd'], ['2026-10-31', '31st']];
  for (const [date, day] of cases) {
    assert.match(text('civil-summons', { issueDate: date }), new RegExp(`this ${day} day of October 2026`));
  }
  assert.match(text('remand-warrant', { returnDate: '2026-11-02' }), /before the 2nd day of November 2026 ?, you shall/);
  assert.match(text('summons-settle-record', { attendanceDate: '2026-11-03' }), /on the 3rd day of November 2026 at the hour/);
  assert.match(text('judgment-summons', { applicationDate: '2026-11-04' }), /application: the 4th day of November 2026/);
  assert.match(text('public-auction-receipt', { receiptDate: '2026-11-05' }), /DATED THIS 5TH DAY OF NOVEMBER 2026/);
  assert.match(text('court-order', { sittingDate: '2026-10-22' }), /THE 22ND DAY OF OCTOBER/);
  // A blank date leaves blanks, not "20" and no stray "th".
  const blank = text('civil-summons', {});
  assert.match(blank, /Issued at +this +day of +\./);
  assert.doesNotMatch(blank, / 20 \.|undefined|NaN/);
});

test('filled details print without a line; blanks left empty keep theirs', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.line:not\(:empty\)\s*\{[^}]*border-bottom:\s*none/);
  const html = output.render({ formType: 'civil-summons', status: 'final', data: { recipientName: 'Ali Sani', serviceFee: '' }, signatures: [] }, 'Unit', allForms['civil-summons']);
  assert.match(html, /<span class="line medium">Ali Sani<\/span>/, 'a filled detail has text, so no line');
  assert.match(html, /Service: ₦ <span class="line short"><\/span>/, 'an empty blank is truly empty, so it keeps its line');
});

test('Court Order: each judge\'s signature above the judge\'s name, and no box for the seal', () => {
  const html = (data, signatures) => output.render({ formType: 'court-order', status: signatures.length ? 'final' : 'draft', data, signatures }, 'Unit', allForms['court-order']);
  const sig = (name, url) => ({ role: 'judge', label: 'Judge', name, title: 'Hon. Justice', imageUrl: url, signedAt: '2026-10-20T10:00:00Z' });
  const single = html({ judgeType: 'single', judgeName: 'Hon. Justice M.A. Haruna', judgeDesignation: 'JUDGE' }, [sig('M.A. Haruna', '/sig/haruna.png')]);
  assert.doesNotMatch(single, /co-seal/);
  const left = single.slice(single.indexOf('class="co-judge"'));
  assert.ok(left.indexOf('/sig/haruna.png') > -1 && left.indexOf('/sig/haruna.png') < left.indexOf('Hon. Justice M.A. Haruna'), 'the signature comes before (above) the name');
  assert.equal((single.match(/\/sig\/haruna\.png/g) || []).length, 1, 'placed once, not again at the foot');
  const draft = html({ judgeType: 'single', judgeName: 'Hon. Justice M.A. Haruna' }, []);
  assert.match(draft, /co-sig-space/, 'room to sign by hand before signing');
  const panel = html({ judgeType: 'panel', judges: [{ name: 'Hon. Justice A. Bello' }, { name: 'Hon. Justice C. Danjuma' }] },
    [sig('C. Danjuma', '/sig/danjuma.png'), sig('A. Bello', '/sig/bello.png')]);
  assert.ok(panel.indexOf('/sig/bello.png') < panel.indexOf('A. Bello') && panel.indexOf('/sig/danjuma.png') > panel.indexOf('A. Bello') && panel.indexOf('/sig/danjuma.png') < panel.indexOf('C. Danjuma'),
    'on a panel, each signature above its own judge, matched by name');
});

test('Cause List: counsel for each side in its own column; an older list keeps its counsel', () => {
  const t = text('cause-list', { sittingDate: '2026-10-16', entries: [{ suitNumber: 'GM/1/2026', parties: 'A v. B', counselFirst: 'S.S. Gana Esq.', counselSecond: 'M. Bala Esq.' }] });
  assert.match(t, /Counsel for Plaintiff \/ Complainant Counsel for Defendant \/ Accused/);
  assert.match(t, /S\.S\. Gana Esq\. M\. Bala Esq\./);
  assert.match(text('cause-list', { sittingDate: '2026-10-16', entries: [{ suitNumber: 'GM/2/2026', counsel: 'Old Counsel Esq.' }] }), /Old Counsel Esq\./);
  const catalogue = require('../src/forms/catalogue');
  const saved = catalogue.cleanData('cause-list', { sittingDate: '2026-10-16', sittingTime: '9:00', division: 'Gombe', preparedBy: 'X', judgeType: 'single',
    entries: [{ suitNumber: 'GM/2/2026', counsel: 'Old Counsel Esq.' }] }).data;
  assert.equal(saved.entries[0].counselFirst, 'Old Counsel Esq.', 'kept on saving again');
});

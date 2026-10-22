/*
 * src/forms/feeSchedule2023.js — the First Schedule of the Gombe State
 * High Court (Increase of Court Fees) Rules, 2023 (Gombe State Legal
 * Notice No. 1 of 2023; commencement 22 December 2023), as the fee list
 * staff pick from when filing.
 *
 * Each fee keeps its item number in the Schedule. A fee "per ₦1,000,000
 * or part thereof", "each exhibit", "per page" and the like is entered
 * once and multiplied by the number in the × box. A percentage fee is
 * worked out on the amount the filer gives. Item 5 (possession of other
 * property) is charged as under item 1 on the sum claimed, and item 1(e)
 * (a claim in foreign currency is converted to naira first) has no fee of
 * its own; they are listed under item 1 as reminders only in the note.
 *
 * It is loaded once into Settings, Process Registry; after that the list
 * there is the one used, and can be corrected like any other.
 */
const SOURCE = 'Gombe State High Court (Increase of Court Fees) Rules, 2023 (Legal Notice No. 1 of 2023)';

const G = {
  1: '1. Recovery of specified sum (also item 5)',
  2: '2. Account taken and payment of the sum found due',
  3: '3. Possession of property, landlord and tenant',
  4: '4. Declaration of title to land, and possession of land',
  6: '6. Administration of the property of a deceased person',
  7: '7. Property of a person of unsound mind',
  8: '8. Distribution of, or succession to, property of a deceased person, or a trust',
  9: '9. Filing of court processes',
  10: '10. Motion on notice',
  11: '11. Motion ex parte',
  12: '12. Damages',
  13: '13. Election cases',
  14: '14. Matrimonial causes',
  15: '15. Legitimacy cases',
  16: '16. Probate and administration',
  17: '17. Appeal',
  18: '18. Miscellaneous'
};

const f = (g, item, amount) => ({ group: G[g], item, amount });
const pct = (g, item, percent) => ({ group: G[g], item, percent });

const FEES = [
  f(1, '1(a) Not exceeding ₦250,000', 20000),
  f(1, '1(b) Exceeding ₦250,000 but not above ₦500,000', 25000),
  f(1, '1(c) Exceeding ₦500,000 but not above ₦1,000,000', 30000),
  f(1, '1(d) Exceeding ₦1,000,000: per ₦1,000,000 or part thereof', 10000),

  f(2, '2(a) Initial fee', 3000),
  f(2, '2(b) Second fee, before setting down for judgment: per ₦100,000 or part thereof found due in excess of each ₦50,000', 1000),

  f(3, '3(a) Annual rent or value not exceeding ₦3,000,000', 8000),
  f(3, '3(b) Annual rent or value exceeding ₦3,000,000: per ₦1,000,000 or part thereof', 4000),
  pct(3, '3(c) Claim of arrears of rent', 2),

  f(4, '4(a) Gross value specified: ₦300,000 or part thereof', 20000),
  f(4, '4(b) Each subsequent ₦100,000', 1000),
  f(4, '4(c) Where no gross value can be specified', 10000),

  f(6, '6(a) Gross value not exceeding ₦50,000 (no dispute on succession or distribution)', 3000),
  f(6, '6(b) Exceeding ₦50,000: each subsequent ₦50,000', 1000),
  f(6, '6(c) Where no gross value can be specified', 5000),

  f(7, '7 (as 6(a)) Gross value not exceeding ₦50,000', 3000),
  f(7, '7 (as 6(b)) Exceeding ₦50,000: each subsequent ₦50,000', 1000),
  f(7, '7 (as 6(c)) Where no gross value can be specified', 5000),

  f(8, '8(a) Gross value of the property (or the property under trust) not exceeding ₦50,000', 3000),
  f(8, '8(b) Exceeding ₦50,000: each subsequent ₦50,000', 1000),
  f(8, '8(c) Where no gross value can be specified', 4000),

  f(9, '9(a)(i) Writ of summons', 4000),
  f(9, '9(a)(ii) Originating summons', 4000),
  f(9, '9(a)(iii) Originating motion', 4000),
  f(9, '9(b) Process affidavit/oath', 500),
  f(9, '9(c) Filing', 500),
  f(9, '9(d) Sealing', 200),
  f(9, '9(e) Each exhibit', 200),

  f(10, '10(a) Motion on notice', 2000),
  f(10, '10(b) Process affidavit/oath', 500),
  f(10, '10(c) Each exhibit', 200),
  f(10, '10(d) Sealing', 200),
  f(10, '10(e) Filing', 500),

  f(11, '11(a) Motion ex parte', 2000),
  f(11, '11(b) Process affidavit/oath', 500),
  f(11, '11(c) Each exhibit', 200),
  f(11, '11(d) Sealing', 200),
  f(11, '11(e) Filing', 500),

  f(12, '12(a) General damages, for ₦1,000,000', 1000),
  f(12, '12(a)(i) General damages, after ₦1,000,000: each ₦1,000,000 or part thereof', 1000),
  f(12, '12(b) Special damages, for ₦1,000,000', 2000),
  f(12, '12(b)(i) Special damages, after the first ₦1,000,000: each ₦1,000,000 or part thereof', 1000),
  f(12, '12(c) Any other relief or assistance not specifically provided for', 2000),

  f(13, '13(a) Petition', 10000),
  f(13, '13(b) Memorandum of appearance', 2000),
  f(13, '13(c) Deposit at the time of presentation of petition', 20000),
  f(13, "13(d) Filing respondent's reply", 6000),
  f(13, '13(e) Filing any application', 2000),

  f(14, '14(a) Any petition (other than alimony)', 4000),
  f(14, '14(b) First citation', 500),
  f(14, '14(c) Any subsequent citation', 300),
  f(14, '14(d) Petition for alimony', 4000),
  f(14, "14(e) Registrar's certificate", 1000),
  f(14, '14(f) Application for decree absolute', 1000),
  f(14, '14(g) Reducing a petition on affidavit to writing', 1000),

  f(15, '15(a) Petition', 4000),
  f(15, '15(b) Sealed decree or copy thereof', 2000),

  f(16, '16(a) Drawing up an administration decree', 800),
  pct(16, '16(b) Drawing up order on further consideration where the property administered exceeds ₦500,000', 1.5),
  f(16, '16(c) Filing an application for probate or administration', 3000),
  f(16, '16(d) Filing oath of execution or administration', 500),
  f(16, '16(e) Filing justification of sureties, for each surety', 500),
  f(16, '16(f) Filing administration bond', 1000),
  f(16, '16(g) Every entering of caveat', 1000),
  f(16, '16(h) Every warning to a caveat', 1000),
  f(16, '16(i)(i) Probate, letters or order of administration: value not exceeding ₦100,000', 1000),
  f(16, '16(i)(ii) Probate, letters or order of administration: value exceeding ₦100,000 but less than ₦500,000', 2000),
  pct(16, '16(i)(iii) Probate, letters or order of administration: value exceeding ₦500,000 but less than ₦1,000,000', 1),
  pct(16, '16(i)(iv) Probate, letters or order of administration: value exceeding ₦1,000,000', 1.5),
  pct(16, '16(i)(v) Probate, letters or order of administration: value exceeding ₦10,000,000 (per ₦2,000,000 or part thereof)', 2),
  pct(16, '16(j) Resealing a grant to bring it into force in Gombe State', 1.5),
  f(16, '16(k) Inventory taken by a court officer', 2000),
  f(16, '16(l) Application to search grants or letters of administration, probate of will, or to inspect a grant or will', 2000),
  f(16, '16(m) Deposit of a will for safe custody', 5000),
  f(16, '16(n)(i) Filing any other application, if alone', 2000),
  f(16, '16(n)(ii) Filing any other application, if accompanied by other paper: each', 200),
  f(16, '16(o) Filing of affidavit', 500),
  f(16, '16(p) Filing a security bond', 500),
  f(16, '16(q) Filing any other paper', 500),
  pct(16, '16(r) Application for devolution', 2),
  f(16, '16(s) Where no letter of administration is required and the amount is below ₦100,000', 2000),

  f(17, '17(a) Appeal from the High Court to the Court of Appeal', 5000),
  f(17, '17(b) Appeal from lower courts to the High Court', 3000),

  f(18, '18(a) Special interpreter of a language not in common use, per day or part thereof (not less than)', 5000),
  f(18, '18(b) Inquiry by a court officer where so ordered, for each sitting', 1000),
  f(18, '18(c) Account taken by a court officer where ordered: per ₦1,000 or part thereof found to have been received', 500),
  f(18, "18(d) Taking down a person's statement where so ordered (not less than)", 1000),
  f(18, '18(e) Searching the archives, for each period of 6 months or part thereof', 2000),
  f(18, '18(f) Drawing up a bill of costs where so directed, per folio of 72 words', 2000),
  f(18, '18(g) Taxing costs where so ordered, per ₦10 or part thereof', 2000),
  f(18, '18(h) Preparing a copy where authorised, per folio of 72 words', 2000),
  f(18, '18(i) Every subpoena', 1000),
  f(18, '18(j) Warrant for prisoner to give evidence', 500),
  f(18, '18(k)(i) Certified true copy of any document: the first five pages', 500),
  f(18, '18(k)(ii) Certified true copy of any document: six pages and above, per page', 50),
  f(18, '18(l) Translation of any document, per page', 100),
  f(18, '18(m) Certificate of judgment', 2000),
  f(18, '18(n) Each form', 1000),
  f(18, '18(o) Oath', 500),
  f(18, '18(p) Administrative affidavit', 500),
  f(18, '18(q) File jacket (probate)', 200)
];

module.exports = { SOURCE, FEES, KEY: 'gombe-2023' };

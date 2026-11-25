/*
 * src/services/payeeImport.js — beneficiaries from a spreadsheet (Excel
 * .xlsx or CSV), for the monthly mandatories.
 *
 * The columns are found by their headings, in any order: Beneficiary (or
 * Name), Bank, Account Number, Account Name (optional), Amount, and
 * Mandatory (optional: to fill several mandatories from one sheet). Rows
 * that cannot be used are reported with the reason, not imported.
 */
const sheetReader = require('./sheetReader');

const COLS = {
  mandatory: /mandator|^title$|category|^item$/i,
  accountName: /account\s*name|a\/c\s*name|acct\.?\s*name/i,
  accountNo: /account\s*(no|number|num|#)|a\/c\s*(no|number)|acct\.?\s*(no|number)|nuban|^account$/i,
  bank: /bank/i,
  name: /beneficiar|^name$|full\s*name|staff\s*name|payee|^names?\b/i,
  amount: /amount|net\s*pay|^pay$|naira|₦|^sum$/i
};
const MAX_ROWS = 2000;

const cell = (v) => (v == null ? '' : String(v)).trim();

function columns(row) {
  const map = {};
  row.forEach((v, i) => {
    const h = cell(v);
    if (!h) return;
    // Account name before account number and name, so "Account Name" is not taken for either.
    for (const key of ['accountName', 'accountNo', 'mandatory', 'bank', 'amount', 'name']) {
      if (map[key] === undefined && COLS[key].test(h)) { map[key] = i; return; }
    }
  });
  return map;
}

// An account number as typed, or as Excel keeps it (a number loses its leading zeros).
function account(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const s = String(Math.round(v));
    return /^\d{7,9}$/.test(s) ? { value: s.padStart(10, '0'), restored: true } : { value: s, restored: false };
  }
  // A CSV saved from Excel loses the zeros too: 7 to 9 digits are taken the same way.
  const t = cell(v).replace(/[\s-]/g, '');
  if (/^\d{7,9}$/.test(t)) return { value: t.padStart(10, '0'), restored: true };
  return { value: t, restored: false };
}
const amountOf = (v) => typeof v === 'number' ? v : Number(cell(v).replace(/[₦N,\s]/gi, ''));

function parse(buffer, fileName) {
  const rows = sheetReader.read(buffer, fileName);
  // The heading row: the first of the first ten with a name, an account and an amount column.
  let head = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const m = columns(rows[i] || []);
    if (m.name !== undefined && m.accountNo !== undefined && m.amount !== undefined) { head = i; map = m; break; }
  }
  if (head < 0) {
    throw Object.assign(new Error('The headings were not found. The first row should have columns for Beneficiary (or Name), Bank, Account Number and Amount (and, if you wish, Account Name and Mandatory).'), { status: 400 });
  }
  const body = rows.slice(head + 1).filter(r => (r || []).some(v => cell(v)));
  if (body.length > MAX_ROWS) throw Object.assign(new Error(`Up to ${MAX_ROWS} beneficiaries at a time.`), { status: 400 });
  const payees = [], problems = [], notes = [];
  body.forEach((r, k) => {
    const line = head + 2 + k; // the row number as the spreadsheet shows it
    const name = cell(r[map.name]), bank = map.bank !== undefined ? cell(r[map.bank]) : '';
    const acct = account(r[map.accountNo]);
    const amount = Math.round(amountOf(r[map.amount]) * 100) / 100;
    const why = !name ? 'no beneficiary name' : !bank ? 'no bank' : !/^\d{10}$/.test(acct.value) ? `account number "${cell(r[map.accountNo])}" is not 10 digits`
      : !(amount > 0) ? 'no amount' : '';
    if (why) { problems.push({ row: line, name, reason: why }); return; }
    if (acct.restored) notes.push({ row: line, name, note: `leading zero restored: ${acct.value}` });
    payees.push({ mandatory: map.mandatory !== undefined ? cell(r[map.mandatory]) : '', name: name.slice(0, 150), bank: bank.slice(0, 100),
      accountNo: acct.value, accountName: map.accountName !== undefined ? cell(r[map.accountName]).slice(0, 150) : '', amount });
  });
  return { payees, problems, notes, hasMandatory: map.mandatory !== undefined };
}

module.exports = { parse };

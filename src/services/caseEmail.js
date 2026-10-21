/*
 * src/services/caseEmail.js — short emails to the parties and counsel of a
 * case (the addresses typed at filing) as it moves on: the invoice issued,
 * the case registered with its suit number, assigned to a court, and the
 * file received at that court's registry, and each date fixed for it in
 * the court diary (or changed).
 *
 * The emails say only the stage of the case, never what is in the file.
 * Each one sent (or failed) is noted on the case. A failure never stops
 * the work that caused it.
 */
const mail = require('./mail');
const processSvc = require('./process');

const naira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function ordinal(d) {
  d = new Date(d);
  const n = d.getDate(), s = ['th', 'st', 'nd', 'rd'], m = n % 100;
  return `${n}${s[(m - 20) % 10] || s[m] || s[0]} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
}
const parties = (c) => [c.firstParty, c.secondParty].map(p => String(p || '').split(/\n+/)[0].trim()).filter(Boolean).join(' v. ');
const roman = (unit) => processSvc.roman(unit && unit.courtNo);

const STAGES = {
  invoice: (c, s) => ({
    subject: 'Invoice for your filing',
    paragraphs: [
      `An invoice has been issued at the Process Registry for the filing ${parties(c)}.`,
      `Reference: ${c.invoice.reference}. Amount: ${naira(c.invoice.total)}.`,
      ...(s.paymentNote ? [`Payment details: ${s.paymentNote}`] : []),
      `After payment, bring the receipt to the Process Registry and quote the reference ${c.invoice.reference}.`
    ]
  }),
  registered: (c) => ({
    subject: `Case registered as ${c.suitNumber}`,
    paragraphs: [
      `The case ${parties(c)} was registered at the Process Registry on ${ordinal(c.registeredAt || new Date())} as Suit No. ${c.suitNumber}.`,
      'It now goes to the Hon. Chief Judge for assignment to a court.'
    ]
  }),
  assigned: (c, s, unit) => ({
    subject: `${c.suitNumber} assigned to High Court No. ${roman(unit)}`,
    paragraphs: [
      `Suit No. ${c.suitNumber}, ${parties(c)}, was assigned to High Court No. ${roman(unit)} on ${ordinal(c.assignedAt || new Date())}.`,
      'The Process Registry will send the file to the registry of that court.'
    ]
  }),
  hearing: (c, s, unit, e) => ({
    subject: `${c.suitNumber}: ${e.changed ? 'date changed' : 'date fixed'}, ${ordinal(e.date + 'T12:00:00Z')}`,
    paragraphs: [
      `Suit No. ${c.suitNumber}, ${parties(c)}, ${e.changed ? 'has been moved to' : 'is fixed for'} ${e.business} before High Court No. ${roman(unit)} on ${new Date(e.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long' })}, ${ordinal(e.date + 'T12:00:00Z')}${e.time ? ` at ${e.time}` : ''}.`
    ]
  }),
  received: (c, s, unit) => ({
    subject: `${c.suitNumber}: file received at High Court No. ${roman(unit)}`,
    paragraphs: [`The file of Suit No. ${c.suitNumber}, ${parties(c)}, was received at the registry of High Court No. ${roman(unit)} on ${ordinal(c.receivedAt || new Date())}.`]
  })
};
const LABELS = { invoice: 'Invoice issued', registered: 'Registered', assigned: 'Assigned', received: 'File received', hearing: 'Court date' };

const addresses = (c) => {
  const e = c.emails || {};
  return [...new Set([...(e.firstParty || []), ...(e.secondParty || []), ...(e.counsel || [])].map(x => String(x).toLowerCase()))];
};

// Send the email for a stage to everyone on the case; note each on the case
// and save it. unit: the court, for the assigned and received stages.
async function notify(c, stage, unit, extra) {
  try {
    const to = addresses(c);
    if (!to.length || !mail.enabled()) return;
    const s = await processSvc.getSettings();
    if (s.partyEmails === false) return;
    const m = STAGES[stage](c, s, unit, extra);
    const msg = {
      subject: `Gombe State High Court: ${m.subject}`,
      ...mail.layout({
        heading: m.subject,
        paragraphs: ['Dear Sir/Madam,', ...m.paragraphs],
        footer: 'This is an automatic message from the Gombe State High Court of Justice about the stage of a case in which your email address was given. Please do not reply to it.'
      })
    };
    const results = await Promise.allSettled(to.map(addr => mail.send({ to: addr, ...msg })));
    const at = new Date();
    c.emailLog = [...(c.emailLog || []), ...results.map((r, i) => ({ stage, to: to[i], at, ok: r.status === 'fulfilled' }))].slice(-100);
    await c.save();
  } catch (e) { console.error(`Case email (${stage}) failed:`, e.message); }
}

// Check and tidy the addresses typed at filing: several per box, separated by commas.
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function cleanEmails(text, label) {
  const list = String(text || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  const bad = list.find(x => !EMAIL.test(x));
  if (bad) throw Object.assign(new Error(`"${bad}" (${label}) is not a valid email address.`), { status: 400 });
  return [...new Set(list.map(x => x.toLowerCase()))].slice(0, 5);
}

module.exports = { notify, cleanEmails, addresses, LABELS, STAGES };

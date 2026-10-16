/*
 * src/services/documentCopy.js — the saved copy of a signed document.
 *
 * When a record becomes final, the server draws the document with the same
 * print templates the browser uses (public/js/core/output.js, run in a
 * sandbox) and stores one standalone HTML file: styles, emblems, signature
 * images and QR code are all inside it, so it opens and prints the same in
 * any browser, offline, years later.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Unit, DocumentCopy } = require('../models');
const catalogue = require('../forms/catalogue');
const store = require('./signatureStore');
const verification = require('./verification');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// The print templates, loaded once.
const output = (() => {
  const sandbox = { window: { App: {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js', 'core', 'output.js'), 'utf8'), sandbox, { filename: 'output.js' });
  return sandbox.window.App.output;
})();

const fileDataUri = (rel, type) => `data:${type};base64,${fs.readFileSync(path.join(PUBLIC, rel)).toString('base64')}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function build(rec) {
  const unit = await Unit.findOne({ key: rec.unitKey });
  const def = catalogue.get(rec.formType);
  const o = rec.toObject();
  const signatures = [];
  for (const s of rec.slots) {
    for (const g of s.signatures) {
      const img = await store.read(g.image).catch(() => null);
      signatures.push({
        label: s.label, role: s.role, name: g.name, title: g.title, signedAt: g.signedAt,
        imageUrl: img ? `data:${img.contentType};base64,${img.buffer.toString('base64')}` : ''
      });
    }
  }
  const doc = {
    ...o, id: String(o._id), status: 'final', signatures,
    qrDataUrl: rec.verifyUrl ? await verification.qrDataUrl(rec.verifyUrl) : ''
  };
  let body = output.render(doc, unit ? unit.name : rec.unitKey, def);
  body = body
    .replace(/src="\/assets\/highcourt\.png"/g, `src="${fileDataUri('assets/highcourt.png', 'image/png')}"`)
    .replace(/src="\/assets\/coat\.png"/g, `src="${fileDataUri('assets/coat.png', 'image/png')}"`);
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'styles.css'), 'utf8');
  const title = `${def ? def.label : rec.formType}${rec.ref ? ' · ' + rec.ref : ''}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style>
<style>
  body { background: #e9edea; margin: 0; padding: 16px; }
  .copy-note { max-width: 210mm; margin: 12px auto 0; font: 13px/1.5 system-ui, sans-serif; color: #44524a; }
  @page { size: A4; margin: 0; }
  @media print { body { background: #fff; padding: 0; } .court-doc { box-shadow: none; width: auto; margin: 0; } .copy-note, .copy-revoked { display: none; } }
</style></head>
<body>
<!--REVOKED-->
${body}
<p class="copy-note">Saved copy of the signed document. Verification code <strong>${esc(rec.verifyCode)}</strong>.
Check it at <a href="${esc(rec.verifyUrl)}">${esc(rec.verifyUrl)}</a>. Saved ${esc(new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}.</p>
</body></html>`;
}

// Called when a record becomes final. A failure is logged, never fatal:
// the copy is made on first download instead.
async function save(rec) {
  try {
    const html = await build(rec);
    await DocumentCopy.updateOne({ record: rec._id }, { $setOnInsert: { record: rec._id, html, generatedAt: new Date() } }, { upsert: true });
  } catch (e) { console.error(`Saved copy for ${rec._id} failed: ${e.message}`); }
}

// The file to download. Revoked documents carry a banner on screen.
async function get(rec) {
  let copy = await DocumentCopy.findOne({ record: rec._id });
  if (!copy) copy = await DocumentCopy.create({ record: rec._id, html: await build(rec), late: true });
  let html = copy.html;
  if (rec.status === 'revoked') {
    const banner = `<div class="copy-revoked" style="max-width:210mm;margin:0 auto 12px;padding:12px 16px;background:#fdeceb;color:#b3261e;border:2px solid #b3261e;border-radius:8px;font:600 15px system-ui,sans-serif">
REVOKED on ${esc(new Date(rec.revokedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))} by ${esc(rec.revokedBy)}. Reason: ${esc(rec.revokeReason)}. This document must not be relied on.</div>`;
    html = html.replace('<!--REVOKED-->', banner);
  }
  return html;
}

function fileName(rec) {
  const def = catalogue.get(rec.formType);
  const base = [def ? def.label : rec.formType, rec.ref, rec.verifyCode].filter(Boolean).join(' ');
  return base.replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/\s+/g, '_').slice(0, 120) + '.html';
}

module.exports = { save, get, build, fileName };

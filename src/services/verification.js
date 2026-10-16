/*
 * src/services/verification.js — codes, content fingerprints and QR codes
 * that let anyone confirm a printed document is genuine.
 */
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('../config');

// No 0/O or 1/I/L, so a code typed from paper is not misread.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function newCode() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `GSHC-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function normaliseCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('GSHC') ? raw.slice(4) : raw;
  if (body.length !== 12) return null;
  return `GSHC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

// Stable JSON: keys sorted, so the same content always gives the same hash.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  return JSON.stringify(v === undefined ? null : v);
}

// Fingerprint of everything that makes up the signed document.
function hashRecord(rec) {
  const content = {
    id: String(rec._id),
    unitKey: rec.unitKey,
    formType: rec.formType,
    data: rec.data,
    verifyCode: rec.verifyCode,
    finalizedAt: rec.finalizedAt,
    signatures: (rec.slots || []).map(s => ({
      role: s.role, label: s.label,
      signed: (s.signatures || []).map(g => ({ user: String(g.user), name: g.name, signedAt: g.signedAt }))
    }))
  };
  return crypto.createHash('sha256').update(stable(content)).digest('hex');
}

// The QR points at the address the document was issued from, unless
// PUBLIC_BASE_URL pins it to one domain.
function baseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  return `${req.protocol}://${req.get('host')}`;
}

function qrDataUrl(url) {
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

module.exports = { newCode, normaliseCode, hashRecord, baseUrl, qrDataUrl };

/*
 * src/services/fileStore.js — private files attached to cases (payment
 * receipts): a photo (PNG, JPEG) or a PDF, up to 5 MB.
 *
 * With CLOUDINARY_URL set, each file is a private ("authenticated") raw
 * asset that only this server can read. Without it (local development and
 * tests) the file is kept in MongoDB.
 */
const crypto = require('crypto');
const config = require('../config');

const MAX_BYTES = 5 * 1024 * 1024;

let cloudinary = null;
if (config.cloudinaryUrl) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config(true);
  cloudinary.config({ secure: true });
}

// What the file really is, from its first bytes, not from its name.
function sniff(buffer) {
  if (buffer.length > 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 4 && buffer.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function save(buffer, originalName, folder = 'receipts') {
  if (!buffer || !buffer.length) throw fail('No file received.');
  if (buffer.length > MAX_BYTES) throw fail('The file must be under 5 MB. A photo or a PDF of the receipt is enough.');
  const contentType = sniff(buffer);
  if (!contentType) throw fail('Upload a photo (PNG or JPEG) or a PDF of the receipt.');
  const name = String(originalName || 'receipt').replace(/[^A-Za-z0-9 ._-]+/g, '').slice(0, 80) || 'receipt';
  const base = { contentType, name, bytes: buffer.length, uploadedAt: new Date() };
  if (!cloudinary) return { ...base, provider: 'inline', dataUrl: `data:${contentType};base64,${buffer.toString('base64')}` };
  const publicId = `${config.cloudinaryFolder}/${folder}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  await new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ public_id: publicId, resource_type: 'raw', type: 'authenticated', overwrite: false },
      (err, res) => (err ? reject(err) : resolve(res))).end(buffer);
  });
  return { ...base, provider: 'cloudinary', publicId };
}

async function read(ref) {
  if (!ref) return null;
  if (ref.provider === 'inline') {
    const m = /^data:([^;]+);base64,(.+)$/.exec(ref.dataUrl || '');
    return m ? { contentType: m[1], buffer: Buffer.from(m[2], 'base64') } : null;
  }
  if (!cloudinary) throw fail('Cloudinary is not configured on this server.', 503);
  const url = cloudinary.utils.private_download_url(ref.publicId, undefined, { resource_type: 'raw', type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 120 });
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw fail('Could not fetch the file.', 502);
  return { contentType: ref.contentType || 'application/octet-stream', buffer: Buffer.from(await res.arrayBuffer()) };
}

module.exports = { save, read, MAX_BYTES };

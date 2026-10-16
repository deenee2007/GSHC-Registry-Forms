/*
 * src/services/signatureStore.js — keeps signature images private.
 *
 * With CLOUDINARY_URL set, images are uploaded as "authenticated" assets:
 * they have no public address, and only this server (holding the API
 * secret) can fetch them. Without it, images are stored inline in MongoDB,
 * which is meant for local development only.
 */
const crypto = require('crypto');
const config = require('../config');

let cloudinary = null;
if (config.cloudinaryUrl) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config(true); // reads CLOUDINARY_URL
  cloudinary.config({ secure: true });
}

const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg' };
const MAX_BYTES = 1024 * 1024;

// Check the file really is a PNG or JPEG, not just named like one.
function sniff(buffer) {
  if (buffer.length > 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

function fromDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  return Buffer.from(m[2], 'base64');
}

async function save(buffer, userId) {
  if (!buffer || !buffer.length) throw Object.assign(new Error('No image received.'), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Signature image must be under 1 MB.'), { status: 400 });
  const mime = sniff(buffer);
  if (!mime) throw Object.assign(new Error('Signature must be a PNG or JPEG image.'), { status: 400 });

  if (!cloudinary) {
    return { provider: 'inline', format: ALLOWED[mime], dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  }
  // A new asset every time, so documents signed earlier keep their image.
  const publicId = `${config.cloudinaryFolder}/signatures/${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { public_id: publicId, type: 'authenticated', resource_type: 'image', overwrite: false },
      (err, res) => (err ? reject(err) : resolve(res))
    ).end(buffer);
  });
  return { provider: 'cloudinary', publicId: result.public_id, format: result.format };
}

// Returns { contentType, buffer } for an image reference.
async function read(ref) {
  if (!ref) return null;
  if (ref.provider === 'inline') {
    const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(ref.dataUrl || '');
    return m ? { contentType: m[1], buffer: Buffer.from(m[2], 'base64') } : null;
  }
  if (!cloudinary) throw new Error('Cloudinary is not configured on this server.');
  const url = cloudinary.utils.private_download_url(ref.publicId, ref.format, {
    type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 60
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not fetch signature image.');
  return { contentType: res.headers.get('content-type') || 'image/png', buffer: Buffer.from(await res.arrayBuffer()) };
}

module.exports = { save, read, fromDataUrl, usingCloudinary: () => !!cloudinary };

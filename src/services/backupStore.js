/*
 * src/services/backupStore.js — where backup files are kept.
 *
 * With CLOUDINARY_URL set, files are private ("authenticated") raw assets:
 * they have no public address and only this server, holding the API
 * secret, can read them. Without it, files go to BACKUP_DIR on this
 * computer, which is for local development and tests only.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

function cloudinaryStore() {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config(true); // reads CLOUDINARY_URL
  cloudinary.config({ secure: true });
  const id = (name) => `${config.cloudinaryFolder}/backups/${name}`;
  const opts = { resource_type: 'raw', type: 'authenticated' };
  return {
    kind: 'cloudinary',
    where: 'Cloudinary (private files)',
    async put(name, buffer) {
      await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ ...opts, public_id: id(name), overwrite: true },
          (err, res) => (err ? reject(err) : resolve(res))).end(buffer);
      });
    },
    async get(name) {
      const url = cloudinary.utils.private_download_url(id(name), undefined, { ...opts, expires_at: Math.floor(Date.now() / 1000) + 120 });
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`Could not read backup file ${name} (${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(name) {
      await cloudinary.uploader.destroy(id(name), { ...opts, invalidate: true });
    },
    async list(prefix) {
      const names = [];
      let next_cursor;
      do {
        const r = await cloudinary.api.resources({ ...opts, prefix: id(prefix), max_results: 500, next_cursor });
        r.resources.forEach(x => names.push(x.public_id.slice(id('').length)));
        next_cursor = r.next_cursor;
      } while (next_cursor);
      return names;
    }
  };
}

function folderStore(dir) {
  const file = (name) => {
    const p = path.resolve(dir, name);
    if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error('Invalid backup file name.');
    return p;
  };
  return {
    kind: 'folder',
    where: `the folder ${path.resolve(dir)} on the server`,
    async put(name, buffer) { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), buffer); },
    async get(name) { return fs.readFileSync(file(name)); },
    async remove(name) { fs.rmSync(file(name), { force: true }); },
    async list(prefix) {
      const sub = path.dirname(file(prefix + 'x'));
      if (!fs.existsSync(sub)) return [];
      return fs.readdirSync(sub).map(f => path.relative(path.resolve(dir), path.join(sub, f)).split(path.sep).join('/'))
        .filter(n => n.startsWith(prefix));
    }
  };
}

// Null when there is nowhere safe to keep backups.
function open() {
  if (config.cloudinaryUrl) return cloudinaryStore();
  if (config.backupDir) return folderStore(config.backupDir);
  return null;
}

module.exports = { open };

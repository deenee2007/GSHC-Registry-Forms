/*
 * scripts/restore-backup.js — put a backup back into an EMPTY database.
 *
 *   node scripts/restore-backup.js <backup file .json.gz> [--uri <MongoDB address>]
 *   node scripts/restore-backup.js --latest [--uri <MongoDB address>]
 *
 * The file is one downloaded from the Dashboard (Backups), or --latest
 * takes the newest one from the backup store (Cloudinary when
 * CLOUDINARY_URL is set). The database is MONGODB_URI unless --uri is
 * given. Saved copies of signed documents are restored from the store when
 * it is reachable. The script refuses to write into a database that
 * already has users, so it can never overwrite a working system.
 */
const fs = require('fs');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { BSON } = require('mongodb');

async function restore({ file, latest, uri, log = console.log }) {
  const config = require('../src/config');
  const store = require('../src/services/backupStore').open();
  const { COLLECTIONS } = require('../src/services/backup');

  let buffer;
  if (latest) {
    if (!store) throw new Error('No backup store: set CLOUDINARY_URL (or BACKUP_DIR), or give a backup file.');
    const names = (await store.list('data/')).filter(n => n.endsWith('.json.gz')).sort();
    if (!names.length) throw new Error('The backup store holds no backups.');
    file = names[names.length - 1];
    log(`Newest backup in the store: ${file}`);
    buffer = await store.get(file);
  } else {
    if (!file) throw new Error('Give a backup file, or --latest.');
    buffer = fs.readFileSync(file);
  }
  const backup = BSON.EJSON.parse(zlib.gunzipSync(buffer).toString('utf8'), { relaxed: false });
  if (backup.app !== 'gshc-registry' || !backup.collections) throw new Error('This is not a GSHC Registry backup file.');

  const conn = await mongoose.createConnection(uri || config.mongoUri, { serverSelectionTimeoutMS: 15000 }).asPromise();
  try {
    const db = conn.db;
    if (await db.collection('users').countDocuments() > 0) {
      throw new Error(`The database "${conn.name}" already has users. Restore only into a new, empty database.`);
    }
    for (const name of COLLECTIONS) {
      const docs = backup.collections[name] || [];
      if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
      log(`  ${name}: ${docs.length}`);
    }

    let copies = 0;
    if (store) {
      const records = new Set((backup.collections.records || []).map(r => String(r._id)));
      for (const name of await store.list('copies/')) {
        const id = name.slice('copies/'.length).replace(/\.html\.gz$/, '');
        if (!records.has(id)) continue;
        const html = zlib.gunzipSync(await store.get(name)).toString('utf8');
        await db.collection('documentcopies').updateOne({ record: new mongoose.Types.ObjectId(id) },
          { $setOnInsert: { record: new mongoose.Types.ObjectId(id), html, generatedAt: new Date(), backedUpAt: new Date() } }, { upsert: true });
        copies++;
      }
    }
    log(`  saved copies of signed documents: ${copies}${store ? '' : ' (no backup store; they will be redrawn when first downloaded)'}`);
    log(`Restored the backup of ${new Date(backup.createdAt).toLocaleString('en-GB')} into "${conn.name}".`);
    return { file, counts: Object.fromEntries(COLLECTIONS.map(n => [n, (backup.collections[n] || []).length])), copies };
  } finally {
    await conn.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--uri');
  restore({ file, latest: args.includes('--latest'), uri: opt('--uri') })
    .then(() => process.exit(0))
    .catch(e => { console.error('Restore failed:', e.message); process.exit(1); });
}

module.exports = { restore };

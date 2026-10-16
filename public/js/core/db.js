/*
 * core/db.js — offline drafts.
 *
 * The server's MongoDB is the record of truth. This small IndexedDB store
 * only holds drafts created or edited while the connection was down (the
 * "outbox"); they are sent to the server automatically when it returns.
 * Workflow actions (submit, approve, sign) always need the server.
 */
(function () {
  window.App = window.App || {};

  const DB_NAME = 'gshc_offline';
  const DB_VERSION = 1;
  let _db = null;
  const listeners = new Set();

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'localId' });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function run(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', mode);
      const req = fn(tx.objectStore('outbox'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    }));
  }

  const all = () => run('readonly', s => s.getAll()).then(list => (list || []).sort((a, b) => a.savedAt - b.savedAt));
  const put = (e) => run('readwrite', s => s.put(e));
  const remove = (id) => run('readwrite', s => s.delete(id));

  function changed() { listeners.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } }); }

  async function mine() {
    const user = window.App.auth.current();
    return (await all()).filter(e => user && e.userId === user.id);
  }

  // Save a new draft, or changes to one, for sending later.
  async function saveDraft({ localId, recordId, version, unitKey, formType, data }) {
    const user = window.App.auth.current();
    const list = await all();
    const existing = list.find(e => (localId && e.localId === localId) || (recordId && e.recordId === recordId));
    const entry = existing || {
      localId: 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      userId: user.id, userName: user.fullName, unitKey, formType,
      op: recordId ? 'update' : 'create', recordId: recordId || null, version
    };
    entry.data = data;
    entry.savedAt = Date.now();
    entry.error = null;
    await put(entry);
    changed();
    return entry;
  }

  let syncing = null;
  // Send every waiting draft. Stops at the first connection failure.
  function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const api = window.App.api;
      let sent = 0, failed = 0;
      for (const e of await mine()) {
        try {
          if (e.op === 'create') await api.post('/records', { unitKey: e.unitKey, formType: e.formType, data: e.data });
          else await api.put('/records/' + e.recordId, { data: e.data, version: e.version });
          await remove(e.localId);
          sent++;
        } catch (err) {
          if (err.offline || err.status === 401) break;
          e.error = err.message; await put(e); failed++;
        }
      }
      return { sent, failed };
    })().finally(() => { syncing = null; changed(); });
    return syncing;
  }

  window.App.offline = {
    all: mine, saveDraft, remove: async (id) => { await remove(id); changed(); }, sync,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();

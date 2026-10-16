/*
 * core/db.js — IndexedDB data layer
 * One database, one store per record-type. Adding a new unit later =
 * add a store name to STORES below and bump DB_VERSION.
 * Registers on the global App namespace.
 */
(function () {
  window.App = window.App || {};

  const DB_NAME = 'gshc_registry';
  const DB_VERSION = 1;

  // Central store registry. To add a unit's data store later, add it here.
  const STORES = {
    users:             { keyPath: 'id', autoIncrement: true, indexes: [['username', { unique: true }], ['unitKey', {}]] },
    units:             { keyPath: 'key' },                       // unit config (the 9 courts, appeals, execution)
    registry_records:  { keyPath: 'id', autoIncrement: true, indexes: [['unitKey', {}], ['status', {}]] },
    appeals_records:   { keyPath: 'id', autoIncrement: true, indexes: [['unitKey', {}], ['status', {}]] },
    execution_records: { keyPath: 'id', autoIncrement: true, indexes: [['unitKey', {}], ['status', {}]] },
    sequences:         { keyPath: 'key' },                       // running numbers for references
    meta:             { keyPath: 'key' }                        // app settings / flags
  };

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        Object.entries(STORES).forEach(([name, cfg]) => {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, {
              keyPath: cfg.keyPath,
              autoIncrement: !!cfg.autoIncrement
            });
            (cfg.indexes || []).forEach(([idxName, opts]) => store.createIndex(idxName, idxName, opts));
          }
        });
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(store, mode) {
    return _db.transaction(store, mode).objectStore(store);
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function add(store, obj)        { await open(); return wrap(tx(store, 'readwrite').add(obj)); }
  async function put(store, obj)        { await open(); return wrap(tx(store, 'readwrite').put(obj)); }
  async function get(store, key)        { await open(); return wrap(tx(store, 'readonly').get(key)); }
  async function getAll(store)          { await open(); return wrap(tx(store, 'readonly').getAll()); }
  async function remove(store, key)     { await open(); return wrap(tx(store, 'readwrite').delete(key)); }
  async function clear(store)           { await open(); return wrap(tx(store, 'readwrite').clear()); }

  async function getByIndex(store, index, value) {
    await open();
    return wrap(tx(store, 'readonly').index(index).getAll(value));
  }

  // Atomic running-number generator for reference strings (e.g. cause numbers)
  async function nextSequence(key) {
    await open();
    const current = (await get('sequences', key)) || { key, value: 0 };
    current.value += 1;
    await put('sequences', current);
    return current.value;
  }

  window.App.db = {
    open, add, put, get, getAll, remove, clear, getByIndex, nextSequence,
    STORES
  };
})();

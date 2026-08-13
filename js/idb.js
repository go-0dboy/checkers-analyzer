/**
 * @module idb
 * IndexedDB-обёртка + хранилища анализатора.
 * Stores:
 *  libraryGames — партии «Библиотеки» (сид из data/ по манифесту);
 *  openings     — база дебютов (сид из data/ по манифесту);
 *  kv           — рабочая копия пользовательской «Базы партий»
 *                 (ключ 'gamesdb'); теряется при очистке кеша —
 *                 первоисточник это файл пользователя (сохранить/открыть).
 * Поставка: data/manifest.json перечисляет файлы баз, доступные по умолчанию;
 * при отсутствии манифеста используются games.json / openings.json.
 */
const DB_NAME = 'checkers-analyzer';
const DB_VERSION = 3;
let dbPromise = null;

export function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, DB_VERSION);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('libraryGames')) db.createObjectStore('libraryGames', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('openings')) db.createObjectStore('openings', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('tb')) db.createObjectStore('tb', { keyPath: 'key' });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  return dbPromise;
}

function req(store, mode, fn) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
export const idbAll = (store) => req(store, 'readonly', (s) => s.getAll());
export const idbGet = (store, key) => req(store, 'readonly', (s) => s.get(key));
export const idbPut = (store, val) => req(store, 'readwrite', (s) => s.put(val));
export const idbDel = (store, key) => req(store, 'readwrite', (s) => s.delete(key));
export const idbClear = (store) => req(store, 'readwrite', (s) => s.clear());
export function idbBulkPut(store, vals) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    vals.forEach((v) => s.put(v));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' }).catch(() => null);
  return r && r.ok ? await r.json() : null;
}

let seedPromise = null;
export function idbSeedIfEmpty() {
  if (!seedPromise) seedPromise = seedOnce();
  return seedPromise;
}
async function seedOnce() {
  try {
    const manifest = (await fetchJson('data/manifest.json')) || {};
    const libFiles = Array.isArray(manifest.library) && manifest.library.length ? manifest.library : ['games.json'];
    const openFiles = Array.isArray(manifest.openings) && manifest.openings.length ? manifest.openings : ['openings.json'];

    const lib = await idbAll('libraryGames');
    if (!lib.length) {
      const all = [];
      for (const f of libFiles) {
        const d = await fetchJson('data/' + f);
        if (d?.games?.length) all.push(...d.games.map(({ id, ...rest }) => rest)); // id отдаём autoIncrement
      }
      if (all.length) await idbBulkPut('libraryGames', all);
    }
    const opens = await idbAll('openings');
    if (!opens.length) {
      const all = [];
      for (const f of openFiles) {
        const d = await fetchJson('data/' + f);
        if (d?.openings?.length) all.push(...d.openings);
      }
      if (all.length) await idbBulkPut('openings', all);
    }
  } catch (e) { console.warn('idb seed:', e); }
}
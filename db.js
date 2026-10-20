// Flip PDF library storage (IndexedDB). Everything stays on this device.
// The rest of the app only talks to this small API, so a cloud-sync backend
// (e.g. Cloudflare D1 + R2) can later be slotted in behind the same functions.
//
// Stores
//   books   : metadata + small cover image     { id, title, author, status, progress, shelves[], tags[], cover:Blob, ... }
//   files   : the PDF itself                   { id, blob }
//   shelves : user collections                 { id, name, createdAt }
//   marks   : bookmarks and notes              { id, bookId, page, type:'bookmark'|'note', text, createdAt }
//   wish    : wishlist / bucket list           { id, title, author, note, link, priority, addedAt }

const DB_NAME = 'flippdf-library';
const DB_VERSION = 1;
let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('shelves', { keyPath: 'id' });
      d.createObjectStore('marks', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      d.createObjectStore('wish', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Library database is blocked by another tab'));
  });
  return dbp;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const finished = (t) => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new Error('Transaction aborted'));
});

async function store(name, mode = 'readonly') {
  const d = await open();
  const t = d.transaction(name, mode);
  return { s: t.objectStore(name), t };
}

function table(name) {
  return {
    async all() { const { s } = await store(name); return req(s.getAll()); },
    async get(id) { const { s } = await store(name); return req(s.get(id)); },
    async put(v) { const { s, t } = await store(name, 'readwrite'); s.put(v); await finished(t); return v; },
    async del(id) { const { s, t } = await store(name, 'readwrite'); s.delete(id); await finished(t); },
    async clear() { const { s, t } = await store(name, 'readwrite'); s.clear(); await finished(t); },
  };
}

export const books = table('books');
export const files = table('files');
export const shelves = table('shelves');
export const marks = table('marks');
export const wish = table('wish');

marks.byBook = async (bookId) => { const { s } = await store('marks'); return req(s.index('bookId').getAll(bookId)); };

export async function deleteBook(id) {
  const d = await open();
  const t = d.transaction(['books', 'files', 'marks'], 'readwrite');
  t.objectStore('books').delete(id);
  t.objectStore('files').delete(id);
  const marksStore = t.objectStore('marks');
  const cur = marksStore.index('bookId').openKeyCursor(IDBKeyRange.only(id));
  cur.onsuccess = () => { const c = cur.result; if (c) { marksStore.delete(c.primaryKey); c.continue(); } };
  await finished(t);
}

export const uid = () =>
  (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export async function storageInfo() {
  try {
    const e = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage: e.usage || 0, quota: e.quota || 0, persisted };
  } catch { return { usage: 0, quota: 0, persisted: false }; }
}
export async function requestPersistence() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

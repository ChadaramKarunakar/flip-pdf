// Flip PDF — library: shelves, tags, status lists, wishlist, bookmarks & notes, backup.
// Talks to the reader (app.js) through window.FlipReader and the 'flip:open' / 'flip:page' events.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import * as db from './db.js';
import { makeZip, readZip } from './zip.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k, d) => { try { return localStorage.getItem('flippdf:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('flippdf:' + k, v); } catch {} },
};

const STATUS = { unread: 'Unread', reading: 'Reading', later: 'Read later', finished: 'Finished' };
const FILTERS = { all: 'All books', reading: 'Reading now', later: 'Read later', finished: 'Finished', fav: 'Favorites' };
const PRIORITY = { 1: 'High', 2: 'Normal', 3: 'Low' };

const L = {
  books: new Map(), shelves: [], wish: [], marks: [],
  route: { name: 'library', key: 'all' },
  q: '', tag: null,
  sort: store.get('sort', 'recent'), layout: store.get('layout', 'grid'),
  selecting: false, selected: new Set(),
  covers: new Map(),            // book id -> { blob, url }
  fileMode: { type: 'add' },    // what the hidden file input is currently for
  readerId: null, page: 0, last: 0, bookMarks: [],
  sheetId: null, group: store.get('group','none'), visited: null, visTimer: null, hl: false, hlColor: store.get('hlColor','#ffd54a'),
};

/* ---------------- small UI helpers ---------------- */
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function busy(text, progress) {
  $('overlay').hidden = false; $('overlayText').textContent = text;
  $('meterWrap').hidden = progress == null;
  if (progress != null) $('meter').style.width = Math.round(progress * 100) + '%';
}
const unbusy = () => ($('overlay').hidden = true);
const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const cleanTitle = (name) => name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

function visCount(b) { return b.visited ? (b.visited.match(/1/g) || []).length : 0; }
function pct(b) {
  if (b.visited && b.pages) return Math.min(100, Math.round(visCount(b) / b.pages * 100));
  if (b.status === 'finished') return 100;
  if (!b.pages || b.pages < 2) return 0;
  if (b.status === 'unread' && !b.progress) return 0;
  return Math.min(100, Math.round(((b.progress || 0) + 1) / b.pages * 100));
}
function coverUrl(b) {
  if (!b.cover) return '';
  const c = L.covers.get(b.id);
  if (c && c.blob === b.cover) return c.url;
  if (c) URL.revokeObjectURL(c.url);
  const url = URL.createObjectURL(b.cover);
  L.covers.set(b.id, { blob: b.cover, url });
  return url;
}
const coverHtml = (b, cls = '') => {
  const u = coverUrl(b);
  return u ? `<img class="${cls}" src="${u}" alt="" draggable="false">`
    : `<div class="ph ${cls}"><span>${esc(b.title)}</span></div>`;
};

/* ---------------- dialogs ---------------- */
function openDialog(html) {
  const d = $('dialog');
  d.innerHTML = `<div class="modal-bg" data-x></div><div class="dlg" role="dialog" aria-modal="true">${html}</div>`;
  d.hidden = false; return d;
}
function closeDialog() { const d = $('dialog'); d.hidden = true; d.innerHTML = ''; }

function askText({ title, label = '', value = '', ok = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    const d = openDialog(`<h3>${esc(title)}</h3>
      <label class="fld">${esc(label)}<input id="dlgInput" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="120"></label>
      <div class="dlg-btns"><button class="btn" data-x>Cancel</button><button class="btn primary" id="dlgOk">${esc(ok)}</button></div>`);
    const inp = $('dlgInput'); inp.focus(); inp.select();
    const done = (v) => { closeDialog(); resolve(v); };
    d.onclick = (e) => { if (e.target.closest('[data-x]')) done(null); else if (e.target.closest('#dlgOk')) done(inp.value.trim() || null); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); };
  });
}
function pickOne({ title, options, note = '' }) {
  return new Promise((resolve) => {
    const d = openDialog(`<h3>${esc(title)}</h3>${note ? `<p class="dlg-note">${esc(note)}</p>` : ''}
      <div class="dlg-list">${options.map((o) => `<button class="dlg-opt" data-v="${esc(o.value)}">${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</button>`).join('')}</div>
      <div class="dlg-btns"><button class="btn" data-x>Cancel</button></div>`);
    d.onclick = (e) => {
      const o = e.target.closest('[data-v]');
      if (o) { closeDialog(); resolve(o.dataset.v); } else if (e.target.closest('[data-x]')) { closeDialog(); resolve(null); }
    };
  });
}
function confirmBox({ title, msg, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const d = openDialog(`<h3>${esc(title)}</h3><p class="dlg-note">${esc(msg)}</p>
      <div class="dlg-btns"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="dlgOk">${esc(ok)}</button></div>`);
    d.onclick = (e) => {
      if (e.target.closest('#dlgOk')) { closeDialog(); resolve(true); } else if (e.target.closest('[data-x]')) { closeDialog(); resolve(false); }
    };
  });
}

/* ---------------- data ---------------- */
async function loadAll() {
  const [b, s, w, m] = await Promise.all([db.books.all(), db.shelves.all(), db.wish.all(), db.marks.all()]);
  L.books = new Map(b.map((x) => [x.id, x]));
  L.shelves = s.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  L.wish = w; L.marks = m;
}
async function saveBook(b) { await db.books.put(b); L.books.set(b.id, b); }

/* ---------------- importing PDFs ---------------- */
async function renderCover(page) {
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 360 / v1.width });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  c.width = c.height = 0;
  return blob;
}
const looksJunk = (t) => !t || /^(untitled|microsoft word|document\d*|\w+\.(docx?|indd|pdf))/i.test(t.trim()) || t.length < 2;

async function importOne(file, wish) {
  const fp = `${file.name}|${file.size}`;
  const dup = [...L.books.values()].find((b) => b.fp === fp);
  if (dup) return { book: dup, isNew: false };
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let info = {}; try { info = (await pdf.getMetadata()).info || {}; } catch {}
  const p1 = await pdf.getPage(1);
  const v1 = p1.getViewport({ scale: 1 });
  let cover = null; try { cover = await renderCover(p1); } catch (e) { console.warn('cover', e); }
  const book = {
    id: db.uid(), fp,
    title: (wish && wish.title) || (looksJunk(info.Title) ? cleanTitle(file.name) : String(info.Title).trim()),
    author: (wish && wish.author) || String(info.Author || '').trim(),
    fileName: file.name, size: file.size, pages: pdf.numPages, ratio: v1.width / v1.height,
    addedAt: Date.now(), openedAt: 0, progress: 0, status: 'unread', shelves: [], tags: [], category: '', visited: '', fav: false, rating: 0, cover,
  };
  // if the user is looking at a shelf, put new books straight onto it
  if (L.route.name === 'shelf' && L.shelves.some((s) => s.id === L.route.key)) book.shelves.push(L.route.key);
  await db.files.put({ id: book.id, blob: file });
  await saveBook(book);
  try { pdf.destroy(); } catch {}
  return { book, isNew: true };
}

async function importFiles(list, opts = {}) {
  const pdfs = [...list].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Please choose PDF files.'); return []; }
  const out = []; let dupes = 0, failed = 0;
  for (let i = 0; i < pdfs.length; i++) {
    busy(`Adding ${i + 1} of ${pdfs.length}: ${pdfs[i].name}`, i / pdfs.length);
    try {
      const r = await importOne(pdfs[i], opts.wish);
      if (r.isNew) out.push(r.book); else { dupes++; if (pdfs.length === 1) out.push(r.book); }
    } catch (e) {
      console.error(e); failed++;
      toast(e && e.name === 'PasswordException' ? `${pdfs[i].name} is password-protected` : `Couldn't add ${pdfs[i].name}`, 4500);
    }
  }
  unbusy();
  if (out.length) db.requestPersistence();
  if (opts.wish && out.length) { await db.wish.del(opts.wish.id); L.wish = L.wish.filter((w) => w.id !== opts.wish.id); }
  render();
  if (out.length === 1 && pdfs.length === 1 && opts.open) { location.hash = '#/read/' + out[0].id; return out; }
  const added = out.filter((b) => !b._dup).length;
  if (added) toast(`Added ${added} book${added > 1 ? 's' : ''}${dupes ? ` (${dupes} already in library)` : ''}`);
  else if (dupes && !failed) toast('That book is already in your library');
  return out;
}

/* ---------------- list helpers ---------------- */
function booksForRoute() {
  const r = L.route; let arr = [...L.books.values()];
  if (r.name === 'shelf') arr = arr.filter((b) => b.shelves.includes(r.key));
  else if (r.name === 'cat') arr = arr.filter((b) => (b.category || '') === r.key);
  else if (r.key === 'fav') arr = arr.filter((b) => b.fav);
  else if (r.key !== 'all') arr = arr.filter((b) => b.status === r.key);
  return arr;
}
function applySearchSort(arr) {
  const q = L.q.trim().toLowerCase();
  if (q) arr = arr.filter((b) => `${b.title} ${b.author} ${b.category || ''} ${b.tags.join(' ')}`.toLowerCase().includes(q));
  if (L.tag) arr = arr.filter((b) => b.tags.includes(L.tag));
  const cmp = {
    recent: (a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt),
    added: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~', undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title),
    progress: (a, b) => pct(b) - pct(a),
  }[L.sort] || (() => 0);
  return arr.sort(cmp);
}

/* ---------------- rendering: sidebar ---------------- */
function counts() {
  const all = [...L.books.values()];
  return {
    all: all.length, reading: all.filter((b) => b.status === 'reading').length, later: all.filter((b) => b.status === 'later').length,
    finished: all.filter((b) => b.status === 'finished').length, fav: all.filter((b) => b.fav).length,
  };
}
function categoriesSide(r) {
  const m = new Map();
  for (const b of L.books.values()) { const c = b.category || ''; if (c) m.set(c, (m.get(c) || 0) + 1); }
  if (!m.size) return '';
  return `<div class="side-h"><span>Categories</span></div>` + [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([c, n]) => `<a class="side-item${r.name === 'cat' && r.key === c ? ' on' : ''}" href="#/cat/${encodeURIComponent(c)}"><span>${esc(c)}</span><b>${n}</b></a>`).join('');
}
function renderSide() {
  const c = counts(); const r = L.route;
  const item = (href, label, n, on) => `<a class="side-item${on ? ' on' : ''}" href="${href}"><span>${esc(label)}</span>${n != null ? `<b>${n}</b>` : ''}</a>`;
  const notesCount = L.marks.length;
  $('side').innerHTML =
    Object.keys(FILTERS).map((k) => item(k === 'all' ? '#/library' : '#/library/' + k, FILTERS[k], c[k], r.name === 'library' && r.key === k)).join('') +
    `<div class="side-sep"></div>` +
    item('#/wishlist', 'Wishlist', L.wish.length, r.name === 'wishlist') +
    item('#/notes', 'Notes & bookmarks', notesCount, r.name === 'notes') +
    categoriesSide(r) +
    `<div class="side-h"><span>Shelves</span><button class="mini" data-act="newShelf" title="New shelf" aria-label="New shelf">+</button></div>` +
    (L.shelves.length
      ? L.shelves.map((s) => item('#/shelf/' + s.id, s.name, [...L.books.values()].filter((b) => b.shelves.includes(s.id)).length, r.name === 'shelf' && r.key === s.id)).join('')
      : `<div class="side-hint">Create shelves like “Novels”, “Study” or “Business”.</div>`) +
    `<div class="side-foot"><button class="side-item btn-like" data-act="backup"><span>Backup &amp; restore</span></button></div>`;
}

/* ---------------- rendering: books ---------------- */
function bookCard(b) {
  const p = pct(b); const sel = L.selected.has(b.id);
  return `<article class="book${sel ? ' sel' : ''}" data-id="${b.id}" tabindex="0" aria-label="${esc(b.title)}">
    <div class="cover" style="--r:${(b.ratio || 0.7).toFixed(3)}">${coverHtml(b)}
      <span class="badge st-${b.status}">${STATUS[b.status]}</span>
      ${b.fav ? '<span class="fav" title="Favorite">♥</span>' : ''}
      <button class="more" data-act="detail" data-id="${b.id}" aria-label="Details">⋯</button>
      <span class="check">${sel ? '✓' : ''}</span>
      <div class="pbar"><i style="width:${p}%"></i></div>
    </div>
    <div class="meta"><div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || ' ')}</div></div>
  </article>`;
}
function bookRow(b) {
  const p = pct(b); const sel = L.selected.has(b.id);
  const shelfNames = b.shelves.map((id) => L.shelves.find((s) => s.id === id)?.name).filter(Boolean);
  return `<article class="row${sel ? ' sel' : ''}" data-id="${b.id}" tabindex="0" aria-label="${esc(b.title)}">
    <div class="cover sm">${coverHtml(b)}<span class="check">${sel ? '✓' : ''}</span></div>
    <div class="rmeta">
      <div class="t">${esc(b.title)}${b.fav ? ' <span class="fav-i">♥</span>' : ''}</div>
      <div class="a">${esc(b.author || 'Unknown author')}</div>
      <div class="rtags"><span class="badge st-${b.status}">${STATUS[b.status]}</span>${shelfNames.map((n) => `<span class="pill">${esc(n)}</span>`).join('')}${b.tags.map((t) => `<span class="pill tag">#${esc(t)}</span>`).join('')}</div>
      <div class="rbar"><div class="pbar"><i style="width:${p}%"></i></div><span>${p}% · ${b.pages || '?'} pages</span></div>
    </div>
    <button class="more" data-act="detail" data-id="${b.id}" aria-label="Details">⋯</button>
  </article>`;
}

function renderBooksView() {
  const r = L.route;
  const base = booksForRoute();
  const title = r.name === 'shelf' ? (L.shelves.find((s) => s.id === r.key)?.name || 'Shelf') : r.name === 'cat' ? (r.key || 'Uncategorised') : FILTERS[r.key];
  $('libTitle').innerHTML = esc(title) + (r.name === 'shelf'
    ? ` <span class="title-actions"><button class="mini" data-act="renameShelf">Rename</button><button class="mini danger" data-act="deleteShelf">Delete shelf</button></span>` : '');
  $('libTools').hidden = false;

  // tag chips for the current list
  const tagCount = new Map();
  base.forEach((b) => b.tags.forEach((t) => tagCount.set(t, (tagCount.get(t) || 0) + 1)));
  if (L.tag && !tagCount.has(L.tag)) L.tag = null;
  $('tagRow').innerHTML = [...tagCount.entries()].sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<button class="chip${L.tag === t ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)} <small>${n}</small></button>`).join('');

  const list = applySearchSort([...base]);
  let html = '';
  if (!L.books.size) {
    html = `<div class="empty"><div class="empty-ico">📚</div><h3>Your library is empty</h3>
      <p>Add PDFs to build your bookshelf. Everything stays on this device, private and offline.</p>
      <button class="btn primary big" data-act="add">+ Add PDFs</button>
      <small>Tip: you can also drag &amp; drop PDFs anywhere on this page.</small></div>`;
  } else if (!list.length) {
    html = `<div class="empty"><h3>${L.q || L.tag ? 'No matching books' : 'Nothing here yet'}</h3>
      <p>${L.q || L.tag ? 'Try a different search or clear the tag filter.' : r.name === 'shelf' ? 'Open a book’s details (⋯) and add it to this shelf, or use Add PDF while viewing this shelf.' : 'Books you mark with this status will show up here.'}</p></div>`;
  } else {
    if (r.name === 'library' && r.key === 'all' && !L.q && !L.tag) {
      const cur = [...L.books.values()].filter((b) => b.status === 'reading').sort((a, b) => b.openedAt - a.openedAt)[0];
      if (cur) html += `<div class="continue" data-id="${cur.id}" tabindex="0">
        <div class="cover sm">${coverHtml(cur)}</div>
        <div class="cmeta"><small>Continue reading</small><div class="t">${esc(cur.title)}</div><div class="a">${esc(cur.author || '')}</div>
        <div class="rbar"><div class="pbar"><i style="width:${pct(cur)}%"></i></div><span>${pct(cur)}%</span></div></div>
        <button class="btn primary" data-act="open" data-id="${cur.id}">Resume</button></div>`;
    }
    const wrap = (arr) => L.layout === 'grid' ? `<div class="grid">${arr.map(bookCard).join('')}</div>` : `<div class="rows">${arr.map(bookRow).join('')}</div>`;
    if (L.group === 'none') html += wrap(list);
    else {
      const keyOf = { author: (b) => b.author || 'Unknown author', category: (b) => b.category || 'Uncategorised', status: (b) => STATUS[b.status] }[L.group];
      const g = new Map(); list.forEach((b) => { const k = keyOf(b); (g.get(k) || g.set(k, []).get(k)).push(b); });
      const last = L.group === 'author' ? 'Unknown author' : 'Uncategorised';
      const keys = [...g.keys()].sort((a, b) => (a === last) - (b === last) || a.localeCompare(b, undefined, { sensitivity: 'base' }));
      html += keys.map((k) => `<section class="grp"><h3>${esc(k)} <small>${g.get(k).length}</small></h3>${wrap(g.get(k))}</section>`).join('');
    }
  }
  $('libBody').innerHTML = html;
}

/* ---------------- rendering: wishlist ---------------- */
function renderWishlist() {
  $('libTitle').textContent = 'Wishlist';
  $('libTools').hidden = true; $('tagRow').innerHTML = '';
  const items = [...L.wish].sort((a, b) => (a.priority - b.priority) || (b.addedAt - a.addedAt));
  $('libBody').innerHTML = `
    <form class="wish-form" id="wishForm" autocomplete="off">
      <input name="title" placeholder="Book title" required maxlength="140">
      <input name="author" placeholder="Author" maxlength="100">
      <input name="link" placeholder="Link (optional)" inputmode="url" maxlength="300">
      <input name="note" placeholder="Note: why you want it" maxlength="200">
      <select name="priority" aria-label="Priority"><option value="1">High priority</option><option value="2" selected>Normal</option><option value="3">Low</option></select>
      <button class="btn primary">Add to wishlist</button>
    </form>
    ${items.length ? `<div class="wish-list">${items.map((w) => `
      <div class="wish p${w.priority}" data-id="${w.id}">
        <div class="w-main"><div class="t">${esc(w.title)}</div>
          <div class="a">${esc(w.author || 'Unknown author')}</div>
          ${w.note ? `<div class="w-note">${esc(w.note)}</div>` : ''}
          ${w.link ? `<a class="w-link" href="${esc(w.link)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>` : ''}</div>
        <span class="pill pr${w.priority}">${PRIORITY[w.priority]}</span>
        <div class="w-btns"><button class="btn" data-act="wishPdf" data-id="${w.id}">I have the PDF</button><button class="btn" data-act="wishDel" data-id="${w.id}">Remove</button></div>
      </div>`).join('')}</div>`
    : `<div class="empty"><div class="empty-ico">✨</div><h3>Your wishlist is empty</h3><p>Save books you want to read someday. When you get the PDF, tap “I have the PDF” and it moves into your library.</p></div>`}`;
}

/* ---------------- rendering: all notes ---------------- */
function renderNotes() {
  $('libTitle').textContent = 'Notes & bookmarks';
  $('libTools').hidden = true; $('tagRow').innerHTML = '';
  const byBook = new Map();
  L.marks.forEach((m) => { if (L.books.has(m.bookId)) (byBook.get(m.bookId) || byBook.set(m.bookId, []).get(m.bookId)).push(m); });
  if (!byBook.size) {
    $('libBody').innerHTML = `<div class="empty"><div class="empty-ico">🔖</div><h3>No bookmarks or notes yet</h3><p>While reading, tap the bookmark icon to save a page, or the notes icon to write a note. They all collect here.</p></div>`;
    return;
  }
  $('libBody').innerHTML = [...byBook.entries()].map(([id, ms]) => {
    const b = L.books.get(id);
    return `<section class="nb"><h4 data-act="open" data-id="${id}">${esc(b.title)}</h4>${ms.sort((x, y) => x.page - y.page).map((m) => `
      <div class="mark" data-act="openMark" data-id="${id}" data-page="${m.page}">
        <span class="m-ico">${m.type === 'note' ? '✎' : m.type === 'highlight' ? `<i class="dot" style="--c:${m.color || HL_COLORS[0]}"></i>` : '🔖'}</span><span class="m-pg">Page ${m.page + 1}</span>
        <span class="m-tx">${esc(m.text || (m.type === 'highlight' ? 'Highlight' : 'Bookmark'))}</span>
        <button class="mini danger" data-act="delMark" data-mid="${m.id}" aria-label="Delete">✕</button></div>`).join('')}</section>`;
  }).join('');
}

function render() {
  renderSide();
  const r = L.route.name;
  if (r === 'wishlist') renderWishlist();
  else if (r === 'notes') renderNotes();
  else renderBooksView();
  $('btnLayout').innerHTML = L.layout === 'grid'
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>';
  $('btnLayout').title = L.layout === 'grid' ? 'Switch to list' : 'Switch to grid';
  $('sort').value = L.sort; $('group').value = L.group;
  updateSelBar();
  if (L.sheetId) renderSheet();
}

/* ---------------- book details sheet ---------------- */
function openSheet(id) { L.sheetId = id; $('sheet').hidden = false; renderSheet(); }
function closeSheet() { L.sheetId = null; $('sheet').hidden = true; $('sheet').innerHTML = ''; }

function renderSheet() {
  const b = L.books.get(L.sheetId); if (!b) { closeSheet(); return; }
  const prevScroll = $('sheet').querySelector('.sheet-card')?.scrollTop || 0;
  const marks = L.marks.filter((m) => m.bookId === b.id).sort((x, y) => x.page - y.page);
  const p = pct(b);
  $('sheet').innerHTML = `<div class="modal-bg" data-close></div>
  <div class="sheet-card" role="dialog" aria-modal="true" aria-label="Book details">
    <button class="x" data-close aria-label="Close">✕</button>
    <div class="sheet-top">
      <div class="s-cover">${coverHtml(b)}</div>
      <div class="s-fields">
        <label class="fld">Title<input data-f="title" value="${esc(b.title)}" maxlength="160"></label>
        <label class="fld">Author<input data-f="author" value="${esc(b.author)}" maxlength="120" placeholder="Unknown"></label>
        <div class="s-info">${b.pages || '?'} pages · ${fmtBytes(b.size || 0)} · added ${fmtDate(b.addedAt)}${b.finishedAt ? ` · finished ${fmtDate(b.finishedAt)}` : ''}</div>
        <div class="s-actions">
          ${b.noFile ? `<button class="btn primary" data-act="attach">Attach the PDF file</button>`
            : `<button class="btn primary" data-act="read">${b.progress > 0 && b.status !== 'finished' ? `Resume · ${p}%` : b.status === 'finished' ? 'Read again' : 'Start reading'}</button>`}
          <button class="btn${b.fav ? ' on' : ''}" data-act="fav">${b.fav ? '♥ Favorite' : '♡ Favorite'}</button>
          <button class="btn" data-act="cover">Change cover</button>
        </div>
      </div>
    </div>
    <div class="s-sec"><h4>Reading progress</h4>
      <div class="rbar"><div class="pbar big"><i style="width:${p}%"></i></div><span>${p}%</span></div>
      <div class="s-info">${b.visited ? `${visCount(b)} of ${b.pages || '?'} pages visited` : 'No pages visited yet'}${b.visited ? ' · <button class="mini" data-act="resetProg">Reset</button>' : ''}</div></div>
    <div class="s-sec"><h4>Category</h4>
      <input class="cat-in" data-f="category" list="catList" value="${esc(b.category || '')}" placeholder="e.g. Fiction, Business, Study" maxlength="40">
      <datalist id="catList">${[...new Set(['Fiction', 'Non-fiction', 'Study', 'Business', 'Self-help', 'Tech', 'Comics', 'Reference', ...[...L.books.values()].map((x) => x.category).filter(Boolean)])].map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="s-sec"><h4>Status</h4><div class="seg">${Object.keys(STATUS).map((k) => `<button class="${b.status === k ? 'on' : ''}" data-status="${k}">${STATUS[k]}</button>`).join('')}</div></div>
    <div class="s-sec"><h4>Rating</h4><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button class="${n <= b.rating ? 'on' : ''}" data-rate="${n}" aria-label="${n} star">★</button>`).join('')}</div></div>
    <div class="s-sec"><h4>Shelves</h4><div class="chips">${L.shelves.map((s) => `<button class="chip${b.shelves.includes(s.id) ? ' on' : ''}" data-shelf="${s.id}">${esc(s.name)}</button>`).join('')}<button class="chip dashed" data-act="newShelfFor">+ New shelf</button></div></div>
    <div class="s-sec"><h4>Tags</h4><div class="chips">${b.tags.map((t) => `<span class="chip on">#${esc(t)} <button class="tx" data-deltag="${esc(t)}" aria-label="Remove tag ${esc(t)}">✕</button></span>`).join('')}<input class="tag-in" data-tag-input placeholder="Add tag, press Enter" maxlength="30"></div></div>
    <div class="s-sec"><h4>Bookmarks &amp; notes (${marks.length})</h4>
      ${marks.length ? marks.map((m) => `<div class="mark" data-act="openMark" data-id="${b.id}" data-page="${m.page}"><span class="m-ico">${m.type === 'note' ? '✎' : '🔖'}</span><span class="m-pg">Page ${m.page + 1}</span><span class="m-tx">${esc(m.text || 'Bookmark')}</span></div>`).join('') : '<div class="side-hint">None yet. Add them while reading.</div>'}</div>
    <div class="s-sec"><button class="btn danger" data-act="delete">Delete from library</button></div>
  </div>`;
  const card = $('sheet').querySelector('.sheet-card'); if (card) card.scrollTop = prevScroll;
}

async function sheetClick(e) {
  if (e.target.closest('[data-close]')) { closeSheet(); return; }
  const b = L.books.get(L.sheetId); if (!b) return;
  const st = e.target.closest('[data-status]');
  if (st) { b.status = st.dataset.status; if (b.status === 'finished' && !b.finishedAt) b.finishedAt = Date.now(); await saveBook(b); render(); return; }
  const rt = e.target.closest('[data-rate]');
  if (rt) { const n = Number(rt.dataset.rate); b.rating = b.rating === n ? 0 : n; await saveBook(b); render(); return; }
  const sh = e.target.closest('[data-shelf]');
  if (sh) { const id = sh.dataset.shelf; b.shelves = b.shelves.includes(id) ? b.shelves.filter((x) => x !== id) : [...b.shelves, id]; await saveBook(b); render(); return; }
  const dt = e.target.closest('[data-deltag]');
  if (dt) { b.tags = b.tags.filter((t) => t !== dt.dataset.deltag); await saveBook(b); render(); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'read') { closeSheet(); location.hash = '#/read/' + b.id; }
  else if (act === 'fav') { b.fav = !b.fav; await saveBook(b); render(); }
  else if (act === 'cover') changeCover(b);
  else if (act === 'resetProg') { if (await confirmBox({ title: 'Reset progress?', msg: 'Pages-visited tracking for this book starts again from zero.', ok: 'Reset' })) { b.visited = ''; b.progress = 0; if (b.status === 'finished') b.status = 'reading'; await saveBook(b); render(); } }
  else if (act === 'newShelfFor') { const s = await newShelf(); if (s) { b.shelves.push(s.id); await saveBook(b); render(); } }
  else if (act === 'attach') { L.fileMode = { type: 'attach', id: b.id }; $('file').click(); }
  else if (act === 'openMark') { closeSheet(); location.hash = `#/read/${a.dataset.id}?p=${Number(a.dataset.page) + 1}`; }
  else if (act === 'delete') {
    if (await confirmBox({ title: 'Delete this book?', msg: `“${b.title}” and its bookmarks and notes will be removed from this device. Your original PDF file isn’t touched.`, ok: 'Delete', danger: true })) {
      await removeBook(b.id); closeSheet(); toast('Book deleted');
    }
  }
}
$('sheet').addEventListener('click', sheetClick);
$('sheet').addEventListener('change', async (e) => {
  const f = e.target.closest('[data-f]'); const b = L.books.get(L.sheetId); if (!f || !b) return;
  const v = f.value.trim();
  if (f.dataset.f === 'title') b.title = v || b.title; else if (f.dataset.f === 'category') b.category = v; else b.author = v;
  await saveBook(b); renderSide(); renderMainOnly();
});
$('sheet').addEventListener('keydown', async (e) => {
  const inp = e.target.closest('[data-tag-input]'); if (!inp || (e.key !== 'Enter' && e.key !== ',')) return;
  e.preventDefault();
  const b = L.books.get(L.sheetId); const t = inp.value.trim().replace(/^#/, '').toLowerCase();
  if (t && !b.tags.includes(t)) { b.tags.push(t); await saveBook(b); render(); }
  $('sheet').querySelector('[data-tag-input]')?.focus();
});
function renderMainOnly() { const r = L.route.name; if (r === 'wishlist') renderWishlist(); else if (r === 'notes') renderNotes(); else renderBooksView(); }

async function removeBook(id) {
  await db.deleteBook(id);
  L.books.delete(id); L.marks = L.marks.filter((m) => m.bookId !== id); L.selected.delete(id);
  const c = L.covers.get(id); if (c) { URL.revokeObjectURL(c.url); L.covers.delete(id); }
  if (L.readerId === id) L.readerId = null;
  render();
}

/* ---------------- custom covers ---------------- */
async function imageToCover(file) {
  const bmp = await createImageBitmap(file);
  const w = 360, h = Math.round(w * bmp.height / bmp.width);
  const c = document.createElement('canvas'); c.width = w; c.height = Math.min(h, 640);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  // fill the cover box, centred (crops very tall/wide images instead of stretching)
  const sc = Math.max(c.width / bmp.width, c.height / bmp.height);
  ctx.drawImage(bmp, (c.width - bmp.width * sc) / 2, (c.height - bmp.height * sc) / 2, bmp.width * sc, bmp.height * sc);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)); c.width = c.height = 0; bmp.close && bmp.close();
  return blob;
}
async function coverFromPage(b, pageNo) {
  const rec = await db.files.get(b.id); if (!rec) throw new Error('PDF missing');
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise;
  try { return await renderCover(await pdf.getPage(Math.min(Math.max(pageNo, 1), pdf.numPages))); } finally { try { pdf.destroy(); } catch {} }
}
async function changeCover(b) {
  const v = await pickOne({ title: 'Change cover', options: [
    { value: 'img', label: 'Choose an image…', sub: 'Any photo or picture from your device' },
    { value: 'page', label: 'Use a page from the PDF…', sub: 'Pick a page number' },
    { value: 'first', label: 'Reset to the first page' }] });
  if (!v) return;
  try {
    if (v === 'img') { L.coverFor = b.id; $('fileCover').click(); return; }
    let blob;
    if (v === 'page') { const t = await askText({ title: 'Page for the cover', label: `Page number (1–${b.pages || '?'})`, value: String(L.page + 1 || 1), ok: 'Use page' }); if (!t) return; busy('Making cover…'); blob = await coverFromPage(b, parseInt(t, 10) || 1); }
    else { busy('Making cover…'); blob = await coverFromPage(b, 1); }
    b.cover = blob; await saveBook(b); toast('Cover updated');
  } catch (e) { console.error(e); toast('Could not change the cover'); } finally { unbusy(); render(); }
}
$('fileCover').onchange = async () => {
  const f = $('fileCover').files[0]; $('fileCover').value = ''; const b = L.books.get(L.coverFor); if (!f || !b) return;
  try { busy('Making cover…'); b.cover = await imageToCover(f); await saveBook(b); toast('Cover updated'); }
  catch (e) { console.error(e); toast('That image could not be used'); } finally { unbusy(); render(); }
};

/* ---------------- shelves ---------------- */
async function newShelf() {
  const name = await askText({ title: 'New shelf', label: 'Shelf name', placeholder: 'e.g. Novels, Study, Business', ok: 'Create' });
  if (!name) return null;
  const ex = L.shelves.find((s) => s.name.toLowerCase() === name.toLowerCase()); if (ex) return ex;
  const s = { id: db.uid(), name, createdAt: Date.now() };
  await db.shelves.put(s); L.shelves.push(s); render(); return s;
}
async function renameShelf() {
  const s = L.shelves.find((x) => x.id === L.route.key); if (!s) return;
  const name = await askText({ title: 'Rename shelf', label: 'Shelf name', value: s.name }); if (!name) return;
  s.name = name; await db.shelves.put(s); render();
}
async function deleteShelf() {
  const s = L.shelves.find((x) => x.id === L.route.key); if (!s) return;
  if (!await confirmBox({ title: `Delete shelf “${s.name}”?`, msg: 'The books stay in your library; they just leave this shelf.', ok: 'Delete shelf', danger: true })) return;
  for (const b of L.books.values()) if (b.shelves.includes(s.id)) { b.shelves = b.shelves.filter((x) => x !== s.id); await saveBook(b); }
  await db.shelves.del(s.id); L.shelves = L.shelves.filter((x) => x.id !== s.id);
  location.hash = '#/library';
}

/* ---------------- select mode (bulk organise) ---------------- */
function updateSelBar() {
  $('selbar').hidden = !L.selecting;
  $('selCount').textContent = `${L.selected.size} selected`;
  $('btnSelect').textContent = L.selecting ? 'Cancel' : 'Select';
  document.body.classList.toggle('selecting', L.selecting);
}
function setSelecting(on) { L.selecting = on; if (!on) L.selected.clear(); render(); }
async function selAction(kind) {
  const ids = [...L.selected];
  if (kind === 'cancel') { setSelecting(false); return; }
  if (!ids.length) { toast('Select some books first'); return; }
  if (kind === 'status') {
    const v = await pickOne({ title: `Set status for ${ids.length} book${ids.length > 1 ? 's' : ''}`, options: Object.entries(STATUS).map(([value, label]) => ({ value, label })) });
    if (!v) return;
    for (const id of ids) { const b = L.books.get(id); b.status = v; if (v === 'finished' && !b.finishedAt) b.finishedAt = Date.now(); await saveBook(b); }
    toast('Status updated'); setSelecting(false);
  } else if (kind === 'shelf') {
    const v = await pickOne({ title: 'Add to shelf', options: [...L.shelves.map((s) => ({ value: s.id, label: s.name })), { value: '__new', label: '+ New shelf…' }] });
    if (!v) return;
    let shelf = L.shelves.find((s) => s.id === v); if (v === '__new') shelf = await newShelf(); if (!shelf) return;
    for (const id of ids) { const b = L.books.get(id); if (!b.shelves.includes(shelf.id)) { b.shelves.push(shelf.id); await saveBook(b); } }
    toast(`Added to “${shelf.name}”`); setSelecting(false);
  } else if (kind === 'delete') {
    if (!await confirmBox({ title: `Delete ${ids.length} book${ids.length > 1 ? 's' : ''}?`, msg: 'They will be removed from this device along with their bookmarks and notes.', ok: 'Delete', danger: true })) return;
    for (const id of ids) await removeBook(id);
    toast('Deleted'); setSelecting(false);
  }
}
$('selbar').addEventListener('click', (e) => { const b = e.target.closest('[data-sel]'); if (b) selAction(b.dataset.sel); });
$('btnSelect').onclick = () => setSelecting(!L.selecting);

/* ---------------- wishlist actions ---------------- */
function normLink(v) {
  v = (v || '').trim(); if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'wishForm') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const title = String(f.get('title') || '').trim(); if (!title) return;
  const w = { id: db.uid(), title, author: String(f.get('author') || '').trim(), link: normLink(f.get('link')),
    note: String(f.get('note') || '').trim(), priority: Number(f.get('priority')) || 2, addedAt: Date.now() };
  await db.wish.put(w); L.wish.push(w); render(); toast('Added to wishlist');
});

/* ---------------- library events ---------------- */
$('libBody').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'detail') { e.stopPropagation(); openSheet(act.dataset.id); return; }
    if (a === 'open') { location.hash = '#/read/' + act.dataset.id; return; }
    if (a === 'add') { L.fileMode = { type: 'add' }; $('file').click(); return; }
    if (a === 'renameShelf') { renameShelf(); return; }
    if (a === 'deleteShelf') { deleteShelf(); return; }
    if (a === 'wishPdf') { L.fileMode = { type: 'wish', id: act.dataset.id }; $('file').click(); return; }
    if (a === 'wishDel') { await db.wish.del(act.dataset.id); L.wish = L.wish.filter((w) => w.id !== act.dataset.id); render(); return; }
    if (a === 'delMark') { e.stopPropagation(); await db.marks.del(act.dataset.mid); L.marks = L.marks.filter((m) => m.id !== act.dataset.mid); render(); return; }
    if (a === 'openMark') { location.hash = `#/read/${act.dataset.id}?p=${Number(act.dataset.page) + 1}`; return; }
  }
  const tag = e.target.closest('[data-tag]');
  if (tag) { L.tag = L.tag === tag.dataset.tag ? null : tag.dataset.tag; renderBooksView(); return; }
  const card = e.target.closest('.book, .row, .continue');
  if (card) {
    const id = card.dataset.id;
    if (L.selecting && !card.classList.contains('continue')) {
      L.selected.has(id) ? L.selected.delete(id) : L.selected.add(id); renderBooksView(); updateSelBar();
    } else location.hash = '#/read/' + id;
  }
});
$('libBody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.closest('input,textarea,select,button,a')) return;
  const card = e.target.closest('.book, .row, .continue'); if (card) card.click();
});
$('tagRow').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tag]'); if (t) { L.tag = L.tag === t.dataset.tag ? null : t.dataset.tag; renderBooksView(); }
});
$('side').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  if (a.dataset.act === 'newShelf') newShelf();
  else if (a.dataset.act === 'backup') backupDialog();
});
let searchT;
$('search').addEventListener('input', (e) => { clearTimeout(searchT); searchT = setTimeout(() => { L.q = e.target.value; renderBooksView(); }, 120); });
$('sort').addEventListener('change', (e) => { L.sort = e.target.value; store.set('sort', L.sort); renderBooksView(); });
$('group').addEventListener('change', (e) => { L.group = e.target.value; store.set('group', L.group); renderBooksView(); });
$('btnLayout').onclick = () => { L.layout = L.layout === 'grid' ? 'list' : 'grid'; store.set('layout', L.layout); render(); };

/* ---------------- adding files (button, drag & drop, share, file handler) ---------------- */
$('btnAdd').onclick = () => { L.fileMode = { type: 'add' }; $('file').click(); };
$('file').onchange = async () => {
  const files = [...$('file').files]; $('file').value = '';
  const mode = L.fileMode; L.fileMode = { type: 'add' };
  if (!files.length) return;
  if (mode.type === 'wish') {
    const w = L.wish.find((x) => x.id === mode.id); await importFiles(files.slice(0, 1), { wish: w });
  } else if (mode.type === 'attach') {
    await attachPdf(mode.id, files[0]);
  } else await importFiles(files);
};
async function attachPdf(id, file) {
  const b = L.books.get(id); if (!b) return;
  try {
    busy('Attaching PDF…');
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    b.pages = pdf.numPages; b.size = file.size; b.fileName = file.name; b.fp = `${file.name}|${file.size}`; delete b.noFile;
    if (!b.cover) { try { b.cover = await renderCover(await pdf.getPage(1)); } catch {} }
    await db.files.put({ id, blob: file }); await saveBook(b); try { pdf.destroy(); } catch {}
    toast('PDF attached');
  } catch (e) { console.error(e); toast('That file could not be opened'); } finally { unbusy(); render(); }
}

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  importFiles(files, { open: files.length === 1 });
});

// PDFs shared to the installed phone app (the service worker stashes them first)
async function openSharedPdf() {
  if (!location.search.includes('shared=1') || !('caches' in window)) return;
  try {
    const c = await caches.open('flippdf-shared');
    const r = await c.match('shared-pdf');
    history.replaceState(null, '', location.pathname + location.hash);
    if (!r) return;
    const blob = await r.blob();
    const name = decodeURIComponent(r.headers.get('x-name') || 'shared.pdf');
    await c.delete('shared-pdf');
    await importFiles([new File([blob], name, { type: 'application/pdf' })], { open: true });
  } catch (e) { console.warn(e); }
}
// "Open with Flip PDF" from the desktop (installed desktop app)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (p) => {
    if (p.files && p.files.length) {
      const files = await Promise.all(p.files.map((h) => h.getFile()));
      importFiles(files, { open: files.length === 1 });
    }
  });
}

/* ---------------- backup & restore ---------------- */
async function backupDialog() {
  const info = await db.storageInfo();
  const d = openDialog(`<h3>Backup &amp; restore</h3>
    <p class="dlg-note">Your library lives on this device. A backup file lets you move it to another phone or computer, or keep a safety copy.</p>
    <div class="store-info">${L.books.size} books · using ${fmtBytes(info.usage)}${info.quota ? ` of ${fmtBytes(info.quota)}` : ''} · ${info.persisted ? 'protected from automatic cleanup' : 'browser may clear it if storage runs low'}</div>
    <div class="dlg-list">
      <button class="dlg-opt" data-b="full">Export backup with PDFs<small>One .zip with books, covers, shelves, notes and progress</small></button>
      <button class="dlg-opt" data-b="meta">Export backup without PDFs<small>Small file: only your organisation, notes and progress</small></button>
      <button class="dlg-opt" data-b="restore">Restore from a backup…<small>Adds anything missing; never overwrites your existing books</small></button>
    </div>
    <div class="dlg-btns"><button class="btn" data-x>Close</button></div>`);
  d.onclick = async (e) => {
    const o = e.target.closest('[data-b]');
    if (o) { closeDialog(); if (o.dataset.b === 'restore') $('fileRestore').click(); else exportBackup(o.dataset.b === 'full'); }
    else if (e.target.closest('[data-x]')) closeDialog();
  };
}
async function exportBackup(withPdfs) {
  try {
    busy('Preparing backup…', 0);
    const books = [...L.books.values()];
    const meta = {
      format: 'flippdf-backup', version: 1, exportedAt: Date.now(), withPdfs,
      books: books.map(({ cover, ...rest }) => ({ ...rest, hasCover: !!cover })),
      shelves: L.shelves, marks: L.marks, wish: L.wish,
    };
    const entries = [{ name: 'library.json', data: JSON.stringify(meta) }];
    for (const b of books) {
      if (b.cover) entries.push({ name: `covers/${b.id}.jpg`, data: b.cover });
      if (withPdfs && !b.noFile) { const rec = await db.files.get(b.id); if (rec) entries.push({ name: `pdfs/${b.id}.pdf`, data: rec.blob }); }
    }
    const zip = await makeZip(entries, (p) => busy('Packing backup…', p));
    const name = `flip-pdf-library-${new Date().toISOString().slice(0, 10)}.zip`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(`Backup saved (${fmtBytes(zip.size)})`, 4500);
  } catch (e) { console.error(e); toast('Backup failed: ' + e.message, 5000); } finally { unbusy(); }
}
$('fileRestore').onchange = async () => {
  const f = $('fileRestore').files[0]; $('fileRestore').value = ''; if (!f) return;
  try {
    busy('Reading backup…');
    const map = await readZip(f);
    const metaBlob = map.get('library.json'); if (!metaBlob) throw new Error('This is not a Flip PDF backup');
    const meta = JSON.parse(await metaBlob.text());
    if (meta.format !== 'flippdf-backup') throw new Error('This is not a Flip PDF backup');
    let added = 0, skipped = 0, noPdf = 0;
    const haveFp = new Set([...L.books.values()].map((b) => b.fp));
    for (const s of meta.shelves || []) if (!L.shelves.some((x) => x.id === s.id)) await db.shelves.put(s);
    const known = new Set([...L.books.keys()]);
    for (const mb of meta.books || []) {
      if (known.has(mb.id) || (mb.fp && haveFp.has(mb.fp))) { skipped++; continue; }
      const { hasCover, ...b } = mb;
      const cv = map.get(`covers/${mb.id}.jpg`); b.cover = cv ? new Blob([cv], { type: 'image/jpeg' }) : null;
      const pdf = map.get(`pdfs/${mb.id}.pdf`);
      if (pdf) await db.files.put({ id: b.id, blob: new Blob([pdf], { type: 'application/pdf' }) }); else { b.noFile = true; noPdf++; }
      await db.books.put(b); added++;
    }
    const markIds = new Set(L.marks.map((m) => m.id));
    for (const m of meta.marks || []) if (!markIds.has(m.id) && (known.has(m.bookId) || (meta.books || []).some((x) => x.id === m.bookId))) await db.marks.put(m);
    const wishIds = new Set(L.wish.map((w) => w.id));
    for (const w of meta.wish || []) if (!wishIds.has(w.id)) await db.wish.put(w);
    await loadAll(); render();
    toast(`Restored ${added} book${added === 1 ? '' : 's'}${skipped ? `, ${skipped} already here` : ''}${noPdf ? `. ${noPdf} need their PDF re-attached (open the book’s details)` : ''}`, 7000);
  } catch (e) { console.error(e); toast('Restore failed: ' + e.message, 6000); } finally { unbusy(); }
};

/* ---------------- reader integration: progress, bookmarks, notes ---------------- */
let saveTimer = null;
function markVisited(b, from, to) {
  const n = b.pages || window.FlipReader.n || 0; if (!n) return;
  let v = b.visited && b.visited.length === n ? b.visited : '0'.repeat(n);
  for (let i = Math.max(0, from); i <= Math.min(n - 1, to); i++) v = v.slice(0, i) + '1' + v.slice(i + 1);
  b.visited = v;
}
async function flushProgress() {
  clearTimeout(saveTimer); saveTimer = null;
  const id = L.readerId; const b = id && L.books.get(id); if (!b) return;
  const n = window.FlipReader.n || b.pages;
  b.progress = L.page; b.openedAt = Date.now(); b.pages = n;
  if (L.last >= n - 1 && n > 1 && b.status !== 'finished' && pct(b) >= 85) { b.status = 'finished'; b.finishedAt = Date.now(); toast('Finished! Marked as read.'); }
  else if (L.page > 0 && (b.status === 'unread' || b.status === 'later')) b.status = 'reading';
  try { await saveBook(b); } catch (e) { console.warn(e); }
}
window.addEventListener('flip:open', async (e) => {
  L.readerId = e.detail.bookId; L.page = window.FlipReader.page;
  L.bookMarks = L.readerId ? await db.marks.byBook(L.readerId) : [];
  const b = L.books.get(L.readerId); if (b) { b.openedAt = Date.now(); b.pages = e.detail.n; saveBook(b); }
  updateBookmarkBtn(); renderHighlights(); if (!$('drawer').hidden) renderDrawer();
});
window.addEventListener('flip:page', (e) => {
  if (e.detail.bookId !== L.readerId) return;
  L.page = e.detail.idx; L.last = e.detail.last;
  updateBookmarkBtn();
  clearTimeout(saveTimer); saveTimer = setTimeout(flushProgress, 600);
  // a page only counts as visited once you've stayed on it for a moment (flicking past doesn't count)
  clearTimeout(L.visTimer);
  const from = e.detail.idx, to = e.detail.last;
  L.visTimer = setTimeout(() => {
    const b = L.books.get(L.readerId); if (!b || L.page !== from) return;
    markVisited(b, from, to); showReadPct(); clearTimeout(saveTimer); saveTimer = setTimeout(flushProgress, 300);
  }, 1200);
  showReadPct();
  if (!$('drawer').hidden) renderDrawer();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgress(); });
window.addEventListener('pagehide', flushProgress);

const marksHere = () => L.bookMarks.filter((m) => m.type === 'bookmark' && m.page >= L.page && m.page <= Math.max(L.last, L.page));
function updateBookmarkBtn() {
  const on = marksHere().length > 0;
  $('bmIcon').setAttribute('fill', on ? 'currentColor' : 'none');
  $('btnBookmark').title = on ? 'Remove bookmark (B)' : 'Bookmark this page (B)';
  $('btnBookmark').classList.toggle('on', on);
}
async function toggleBookmark() {
  if (!L.readerId) return;
  const here = marksHere();
  if (here.length) {
    for (const m of here) await db.marks.del(m.id);
    L.bookMarks = L.bookMarks.filter((m) => !here.includes(m)); toast('Bookmark removed', 1400);
  } else {
    const m = { id: db.uid(), bookId: L.readerId, page: L.page, type: 'bookmark', text: '', createdAt: Date.now() };
    await db.marks.put(m); L.bookMarks.push(m); toast(`Bookmarked page ${L.page + 1}`, 1400);
  }
  L.marks = await db.marks.all(); updateBookmarkBtn(); if (!$('drawer').hidden) renderDrawer();
}
$('btnBookmark').onclick = toggleBookmark;

function showReadPct() {
  let s = $('readPct');
  if (!s) { s = document.createElement('span'); s.id = 'readPct'; s.className = 'readpct'; $('bar').appendChild(s); }
  const b = L.books.get(L.readerId); if (!b) { s.textContent = ''; return; }
  s.textContent = `${pct(b)}% read · ${visCount(b)} of ${b.pages || '?'} pages visited`;
}

/* ---------------- highlights & comments (draw a box over any part of a page) ---------------- */
const HL_COLORS = ['#ffd54a', '#7bdc8a', '#6ec6ff', '#ff8fb1'];
function renderHighlights() {
  const R = window.FlipReader; if (!L.readerId) return;
  const byPage = new Map();
  L.bookMarks.filter((m) => m.type === 'highlight' && m.rect).forEach((m) => (byPage.get(m.page) || byPage.set(m.page, []).get(m.page)).push(m));
  for (let i = 0; i < R.n; i++) {
    const pg = R.pageEl(i); if (!pg) continue;
    let layer = pg.querySelector(':scope > .hl-layer');
    const list = byPage.get(i);
    if (!list) { layer && layer.remove(); continue; }
    if (!layer) { layer = document.createElement('div'); layer.className = 'hl-layer'; pg.appendChild(layer); }
    layer.innerHTML = list.map((m) => `<div class="hl${m.text ? ' has-c' : ''}" data-mid="${m.id}" style="left:${m.rect.x * 100}%;top:${m.rect.y * 100}%;width:${m.rect.w * 100}%;height:${m.rect.h * 100}%;--c:${m.color || HL_COLORS[0]}" title="${esc(m.text || 'Highlight')}"></div>`).join('');
  }
}
window.addEventListener('flip:built', () => { renderHighlights(); });

function setHighlightMode(on) {
  L.hl = on; document.body.classList.toggle('hl-on', on);
  $('btnHighlight').classList.toggle('on', on);
  let bar = $('hlbar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'hlbar'; bar.className = 'hlbar'; document.body.appendChild(bar); }
  bar.hidden = !on;
  if (on) {
    if (window.FlipReader.mode !== 'slide') { window.FlipReader.useReaderMode(); toast('Switched to Reader view for highlighting', 2200); }
    bar.innerHTML = `<span>Drag on the page to highlight</span>` + HL_COLORS.map((c) => `<button class="sw${c === L.hlColor ? ' on' : ''}" data-c="${c}" style="--c:${c}" aria-label="Colour"></button>`).join('') + `<button class="btn" data-done>Done</button>`;
  }
}
$('btnHighlight').onclick = () => setHighlightMode(!L.hl);
document.addEventListener('click', (e) => {
  const bar = e.target.closest('#hlbar'); if (!bar) return;
  const c = e.target.closest('[data-c]'); if (c) { L.hlColor = c.dataset.c; store.set('hlColor', L.hlColor); bar.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === c)); }
  if (e.target.closest('[data-done]')) setHighlightMode(false);
});

async function editMark(m) {
  return new Promise((resolve) => {
    const isHl = m.type === 'highlight';
    const d = openDialog(`<h3>${isHl ? 'Highlight' : m.type === 'note' ? 'Note' : 'Bookmark'} · page ${m.page + 1}</h3>
      <label class="fld">${isHl ? 'Comment (optional)' : 'Text'}<textarea id="mkText" rows="4" maxlength="600">${esc(m.text || '')}</textarea></label>
      ${isHl ? `<div class="hl-cols">${HL_COLORS.map((c) => `<button class="sw${c === (m.color || HL_COLORS[0]) ? ' on' : ''}" data-c="${c}" style="--c:${c}" aria-label="Colour"></button>`).join('')}</div>` : ''}
      <div class="dlg-btns"><button class="btn danger" id="mkDel">Delete</button><button class="btn" data-x>Cancel</button><button class="btn primary" id="mkOk">Save</button></div>`);
    let color = m.color; $('mkText').focus();
    d.onclick = async (e) => {
      const c = e.target.closest('[data-c]');
      if (c) { color = c.dataset.c; d.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === c)); return; }
      if (e.target.closest('#mkOk')) { m.text = $('mkText').value.trim(); if (isHl) m.color = color || m.color; await db.marks.put(m); closeDialog(); afterMarkChange(); resolve(); }
      else if (e.target.closest('#mkDel')) { await db.marks.del(m.id); L.bookMarks = L.bookMarks.filter((x) => x.id !== m.id); closeDialog(); afterMarkChange(); resolve(); }
      else if (e.target.closest('[data-x]')) { closeDialog(); resolve(); }
    };
  });
}
async function afterMarkChange() {
  L.marks = await db.marks.all(); updateBookmarkBtn(); renderHighlights(); if (!$('drawer').hidden) renderDrawer();
}

// drawing a box
let drag = null;
$('reader').addEventListener('pointerdown', (e) => {
  if (!L.hl) return;
  const hl = e.target.closest('.hl');
  if (hl) { e.preventDefault(); const m = L.bookMarks.find((x) => x.id === hl.dataset.mid); if (m) editMark(m); return; }
  const pg = e.target.closest('.pg'); if (!pg) return;
  e.preventDefault(); const r = pg.getBoundingClientRect();
  const box = document.createElement('div'); box.className = 'hl draft'; box.style.setProperty('--c', L.hlColor);
  let layer = pg.querySelector(':scope > .hl-layer'); if (!layer) { layer = document.createElement('div'); layer.className = 'hl-layer'; pg.appendChild(layer); }
  layer.appendChild(box);
  drag = { pg, r, box, x0: (e.clientX - r.left) / r.width, y0: (e.clientY - r.top) / r.height, id: e.pointerId };
  drag.x1 = drag.x0; drag.y1 = drag.y0;
  try { $('reader').setPointerCapture(e.pointerId); } catch {}
}, true);
$('reader').addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.x1 = Math.min(1, Math.max(0, (e.clientX - drag.r.left) / drag.r.width)); drag.y1 = Math.min(1, Math.max(0, (e.clientY - drag.r.top) / drag.r.height));
  const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
  Object.assign(drag.box.style, { left: x * 100 + '%', top: y * 100 + '%', width: Math.abs(drag.x1 - drag.x0) * 100 + '%', height: Math.abs(drag.y1 - drag.y0) * 100 + '%' });
});
async function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const d = drag; drag = null; d.box.remove();
  const rect = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
  if (rect.w < 0.02 || rect.h < 0.01) return;               // ignore taps
  const idx = Number(d.pg.dataset.n) - 1;
  const m = { id: db.uid(), bookId: L.readerId, page: idx, type: 'highlight', rect, color: L.hlColor, text: '', createdAt: Date.now() };
  await db.marks.put(m); L.bookMarks.push(m); await afterMarkChange();
  toast('Highlighted — tap it to add a comment', 2200);
}
$('reader').addEventListener('pointerup', endDrag);
$('reader').addEventListener('pointercancel', endDrag);
$('reader').addEventListener('click', (e) => { if (L.hl) { e.stopPropagation(); e.preventDefault(); } }, true);

function renderDrawer() {
  const items = [...L.bookMarks].sort((a, b) => a.page - b.page);
  $('drawer').innerHTML = `
    <div class="dr-head"><h3>Bookmarks, notes &amp; highlights</h3><button class="mini" data-dr="close" aria-label="Close">✕</button></div>
    <form class="dr-form" id="noteForm"><textarea name="text" rows="3" maxlength="600" placeholder="Write a note for page ${L.page + 1}…"></textarea>
      <button class="btn primary">Save note</button></form>
    <div class="dr-list">${items.length ? items.map((m) => `
      <div class="mark" data-dr="go" data-page="${m.page}"><span class="m-ico">${m.type === 'note' ? '✎' : m.type === 'highlight' ? `<i class="dot" style="--c:${m.color || HL_COLORS[0]}"></i>` : '🔖'}</span><span class="m-pg">Page ${m.page + 1}</span>
        <span class="m-tx">${esc(m.text || (m.type === 'highlight' ? 'Highlight' : 'Bookmark'))}</span>${m.type !== 'bookmark' ? `<button class="mini" data-dr="edit" data-mid="${m.id}" aria-label="Edit">✎</button>` : ''}<button class="mini danger" data-dr="del" data-mid="${m.id}" aria-label="Delete">✕</button></div>`).join('')
      : '<div class="side-hint">No bookmarks or notes in this book yet. Use the bookmark button, or write a note above.</div>'}</div>`;
}
function toggleDrawer(force) {
  const open = force ?? $('drawer').hidden;
  $('drawer').hidden = !open; if (open) { renderDrawer(); $('drawer').querySelector('textarea')?.focus(); }
}
$('btnNotes').onclick = () => toggleDrawer();
$('drawer').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-dr]'); if (!t) return;
  const k = t.dataset.dr;
  if (k === 'close') toggleDrawer(false);
  else if (k === 'del') {
    e.stopPropagation(); await db.marks.del(t.dataset.mid);
    L.bookMarks = L.bookMarks.filter((m) => m.id !== t.dataset.mid); await afterMarkChange();
  } else if (k === 'edit') { e.stopPropagation(); const m = L.bookMarks.find((x) => x.id === t.dataset.mid); if (m) editMark(m); } else if (k === 'go') { window.FlipReader.goto(Number(t.dataset.page)); if (innerWidth < 720) toggleDrawer(false); }
});
$('drawer').addEventListener('submit', async (e) => {
  if (e.target.id !== 'noteForm') return; e.preventDefault();
  const text = new FormData(e.target).get('text').toString().trim(); if (!text || !L.readerId) return;
  const m = { id: db.uid(), bookId: L.readerId, page: L.page, type: 'note', text, createdAt: Date.now() };
  await db.marks.put(m); L.bookMarks.push(m); L.marks = await db.marks.all(); renderDrawer(); toast('Note saved', 1400);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('dialog').hidden) { $('dialog').querySelector('[data-x]')?.click(); return; }
    if (!$('sheet').hidden) { closeSheet(); return; }
    if (!$('drawer').hidden) { toggleDrawer(false); return; }
    if (L.selecting) { setSelecting(false); return; }
    if (document.body.classList.contains('view-reader')) location.hash = '#/library';
    return;
  }
  if (e.target.closest('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!document.body.classList.contains('view-reader') || !L.readerId) return;
  if (e.key === 'b' || e.key === 'B') toggleBookmark();
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); toggleDrawer(); }
  else if (e.key === 'h' || e.key === 'H') setHighlightMode(!L.hl);
});

/* ---------------- routing ---------------- */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, ''); const [path, query = ''] = raw.split('?');
  const [a = 'library', b] = path.split('/');
  const q = new URLSearchParams(query);
  if (a === 'read' && b) return { name: 'read', key: b, page: q.get('p') ? Math.max(0, Number(q.get('p')) - 1) : null };
  if (a === 'shelf' && b) return { name: 'shelf', key: b };
  if (a === 'cat' && b) return { name: 'cat', key: decodeURIComponent(b) };
  if (a === 'wishlist') return { name: 'wishlist', key: '' };
  if (a === 'notes') return { name: 'notes', key: '' };
  return { name: 'library', key: FILTERS[b] ? b : 'all' };
}
function setView(v) {
  document.body.classList.toggle('view-reader', v === 'reader');
  document.body.classList.toggle('view-library', v === 'library');
}
async function route() {
  const r = parseHash();
  if (r.name !== 'read' && document.body.classList.contains('view-reader')) await flushProgress();
  closeSheet(); toggleDrawer(false); if (L.hl && r.name !== 'read') setHighlightMode(false);
  if (r.name === 'read') { await enterReader(r.key, r.page); return; }
  if (r.name === 'shelf' && !L.shelves.some((s) => s.id === r.key)) { location.replace('#/library'); return; }
  if (L.selecting && (r.name !== L.route.name || r.key !== L.route.key)) { L.selecting = false; L.selected.clear(); }
  L.route = r; L.tag = null;
  setView('library'); document.title = 'Flip PDF';
  $('title').textContent = '';
  render();
}
async function enterReader(id, page) {
  const b = L.books.get(id);
  if (!b) { toast('That book is no longer in your library'); location.replace('#/library'); return; }
  if (b.noFile) { toast('This book’s PDF is missing. Open its details and attach the file.', 5000); location.replace('#/library'); openSheet(id); return; }
  if (window.FlipReader.bookId === id) {
    setView('reader'); window.FlipReader.activate();
    if (page != null) window.FlipReader.goto(page);
    $('title').textContent = b.title; return;
  }
  const rec = await db.files.get(id);
  if (!rec) { b.noFile = true; await saveBook(b); toast('This book’s PDF file is missing from storage.', 5000); location.replace('#/library'); return; }
  setView('reader');
  const file = new File([rec.blob], b.fileName || 'book.pdf', { type: 'application/pdf' });
  const ok = await window.FlipReader.loadFile(file, { bookId: id, title: b.title, startPage: page != null ? page : (b.progress || 0) });
  if (!ok) location.replace('#/library');
}
window.addEventListener('hashchange', route);

/* ---------------- boot ---------------- */
(async function init() {
  try {
    await db.open();
    await loadAll();
  } catch (e) {
    console.error(e);
    $('libBody').innerHTML = `<div class="empty"><h3>Library storage isn’t available</h3><p>This browser mode doesn’t allow saving books (private/incognito windows often block it). Open Flip PDF in a normal window.</p></div>`;
    return;
  }
  await route();
  openSharedPdf();
})();

// small hook for automated tests
window.__lib = { L, importFiles, db };

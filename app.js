// Flip PDF — turn any PDF into a flippable book. Runs entirely in the browser.
import * as pdfjsLib from './vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), host: $('bookHost'), title: $('title'),
  slider: $('slider'), pageInput: $('pageInput'), pageTotal: $('pageTotal'), quality: $('quality'),
  prep: $('prep'), overlay: $('overlay'), overlayText: $('overlayText'), meterWrap: $('meterWrap'),
  meter: $('meter'), toast: $('toast'), modeIcon: $('modeIcon'), reader: $('reader'),
};

const store = {
  get: (k, d) => { try { return localStorage.getItem('flippdf:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('flippdf:' + k, v); } catch {} },
};

function IS_PHONE() {
  try { return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700; } catch { return false; }
}
const LOW_MEM = IS_PHONE() || (navigator.deviceMemory && navigator.deviceMemory <= 4);

const S = {
  pdf: null, n: 0, ratio: 0.66, name: '', key: '', bookId: null,
  tw: 980, th: 1400,
  urls: [], blobs: [], imgs: [], inflight: {}, failed: {}, done: 0,
  flip: null, cur: 0, gen: 0, pumping: false,
  mode: store.get('mode', IS_PHONE() ? 'slide' : 'spread'), // 'spread' | 'single' (curl) | 'slide' (Kindle-style)
  builtMode: null,                         // what the current book was built as
  theme: store.get('theme', 'dark'),
  th0: Number(store.get('quality', LOW_MEM ? '1000' : '1400')),
  win: LOW_MEM ? 20 : Infinity,            // how many pages around the current one stay rendered
};

/* ---------- small helpers ---------- */
let toastTimer;
function toast(msg, ms = 3200) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}
function showOverlay(text, progress) {
  el.overlay.hidden = false; el.overlayText.textContent = text;
  el.meterWrap.hidden = progress == null;
  if (progress != null) el.meter.style.width = Math.round(progress * 100) + '%';
}
const hideOverlay = () => (el.overlay.hidden = true);
const blobToDataURL = (b) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b);
});

/* ---------- theme / mode ---------- */
function applyTheme() { document.body.dataset.theme = S.theme; }
const MODE_ICON = {
  spread: 'M3 5h8v14H3zM13 5h8v14h-8z',
  single: 'M6 5h12v14H6z',
  slide: 'M3 12h13M12 7l5 5-5 5M20 5v14',
};
const MODE_NAME = { spread: 'Two-page book', single: 'Single page (curl)', slide: 'Reader (swipe, one page)' };
function modeIconPath() {
  el.modeIcon.setAttribute('d', MODE_ICON[S.mode]);
  $('btnMode').title = `View: ${MODE_NAME[S.mode]} (M)`;
}
applyTheme(); modeIconPath();
el.quality.value = String(S.th0);
S.th = S.th0;

$('btnTheme').onclick = () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; store.set('theme', S.theme); applyTheme(); };
$('btnMode').onclick = () => {
  // on a narrow screen the two-page spread isn't available, so skip it
  const order = el.stage.clientWidth < 560 ? ['single', 'slide'] : ['spread', 'single', 'slide'];
  S.mode = order[(Math.max(order.indexOf(S.mode), 0) + 1) % order.length]; store.set('mode', S.mode); modeIconPath();
  if (S.pdf) { buildBook(); toast(MODE_NAME[S.mode], 1500); }
};
$('btnFull').onclick = toggleFullscreen;
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}
document.addEventListener('fullscreenchange', () => setTimeout(layout, 120));

/* ---------- opening a PDF (the library decides which one) ---------- */
async function loadFile(file, opts = {}) {
  document.body.classList.remove('view-library'); document.body.classList.add('view-reader');
  showOverlay('Opening…');
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    resetBook();
    S.pdf = pdf; S.n = pdf.numPages;
    S.bookId = opts.bookId || null;
    S.name = opts.title || file.name.replace(/\.pdf$/i, '');
    S.key = `pos:${file.name}:${file.size}:${S.n}`;
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    S.ratio = vp.width / vp.height;
    setQuality(S.th0);
    const start = opts.startPage != null ? opts.startPage : Number(store.get(S.key, '0')) || 0;
    S.cur = Math.min(Math.max(start, 0), S.n - 1);
    el.title.textContent = S.name;
    document.title = `${S.name} — Flip PDF`;
    document.body.classList.add('has-book');
    buildBook();
    window.dispatchEvent(new CustomEvent('flip:open', { detail: { bookId: S.bookId, n: S.n } }));
    return true;
  } catch (err) {
    console.error(err);
    const msg = err?.name === 'PasswordException'
      ? 'This PDF is password-protected. Remove the password and try again.'
      : 'Could not open that file. Is it a valid PDF?';
    toast(msg, 5000);
    return false;
  } finally {
    hideOverlay();
  }
}

function setQuality(th) {
  S.th = th; S.tw = Math.round(th * S.ratio);
}
el.quality.onchange = () => {
  S.th0 = Number(el.quality.value); store.set('quality', String(S.th0));
  if (!S.pdf) return;
  clearCache(); setQuality(S.th0); buildBook();
};

function revokeAll() { S.urls.forEach((u) => u && URL.revokeObjectURL(u)); }
function clearCache() {
  S.gen++; revokeAll();
  S.urls = []; S.blobs = []; S.imgs = []; S.inflight = {}; S.failed = {}; S.done = 0; S.pumping = false;
}
function resetBook() {
  clearCache();
  if (S.flip) { try { S.flip.destroy(); } catch {} S.flip = null; }
  S.builtMode = null;
}

/* ---------- layout ---------- */
function effMode() {
  const stageW = el.stage.clientWidth;
  return S.mode === 'spread' && stageW < 560 ? 'single' : S.mode;
}
function fit(mode) {
  const cs = getComputedStyle(el.stage);
  const aw = el.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = el.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const per = mode === 'single' ? 1 : 2;
  let w = aw, h = w / (S.ratio * per);
  if (h > ah) { h = ah; w = h * S.ratio * per; }
  return { w: Math.max(Math.floor(w), 100), h: Math.max(Math.floor(h), 100), pageW: Math.max(Math.floor(w / per), 50) };
}
function layout() {
  if (!S.pdf || !document.body.classList.contains('view-reader')) return;
  if (effMode() !== S.builtMode) { buildBook(); return; }
  if (S.builtMode === 'slide') { sizeReader(); return; }
  const f = fit(S.builtMode);
  el.host.style.width = f.w + 'px'; el.host.style.height = f.h + 'px';
  S.flip?.update();
}
let rz;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 80); });

/* ---------- building the flipbook ---------- */
function buildBook() {
  if (S.flip) {
    try { S.cur = S.flip.getCurrentPageIndex(); } catch {}
    try { S.flip.destroy(); } catch {}
    S.flip = null;
  }
  const mode0 = effMode();
  document.body.classList.toggle('slide', mode0 === 'slide');
  if (mode0 === 'slide') { buildReader(); return; }
  el.reader.hidden = true; el.reader.innerHTML = '';
  // brand-new container so the library starts clean
  const old = $('book'); const fresh = document.createElement('div'); fresh.id = 'book';
  if (old) old.replaceWith(fresh); else el.host.appendChild(fresh); // destroy() may remove the container

  const mode = effMode(); S.builtMode = mode;
  const f = fit(mode);
  el.host.style.width = f.w + 'px'; el.host.style.height = f.h + 'px';

  // page elements (images are filled in lazily)
  S.imgs = []; const nodes = [];
  for (let i = 0; i < S.n; i++) {
    const d = document.createElement('div');
    d.className = 'page'; d.dataset.density = i === 0 || i === S.n - 1 ? 'hard' : 'soft'; d.dataset.n = i + 1;
    const img = new Image(); img.alt = `Page ${i + 1}`; img.draggable = false;
    d.appendChild(img); nodes.push(d); S.imgs.push(img);
    if (S.urls[i]) { img.src = S.urls[i]; d.classList.add('ready'); }
  }

  const baseW = 500, baseH = Math.round(baseW / S.ratio);
  const flip = new St.PageFlip(fresh, {
    width: baseW, height: baseH, size: 'stretch',
    minWidth: mode === 'single' ? f.pageW : 100, maxWidth: 4000, minHeight: 100, maxHeight: 6000,
    showCover: true, usePortrait: true, startPage: Math.min(S.cur, S.n - 1),
    drawShadow: true, maxShadowOpacity: 0.45, flippingTime: 750,
    mobileScrollSupport: false, swipeDistance: 25, useMouseEvents: true, clickEventForward: false,
  });
  flip.loadFromHTML(nodes);
  flip.on('flip', (e) => onFlip(e.data));
  S.flip = flip;

  el.slider.max = S.n; el.pageInput.max = S.n; el.pageTotal.textContent = '/ ' + S.n;
  onFlip(Math.min(S.cur, S.n - 1));
  pump();
  window.dispatchEvent(new CustomEvent('flip:built'));
}

function onFlip(idx) {
  S.cur = idx; store.set(S.key, String(idx));
  const landscape = S.flip?.getOrientation?.() === 'landscape';
  el.slider.value = idx + 1;
  el.pageInput.value = idx + 1;
  const lab = landscape && idx > 0 && idx + 1 < S.n ? `${idx + 1}–${idx + 2}` : String(idx + 1);
  el.pageInput.title = `Showing ${lab}`;
  const last = landscape && idx > 0 && idx + 1 < S.n ? idx + 1 : idx;
  window.dispatchEvent(new CustomEvent('flip:page', { detail: { idx, last, n: S.n, bookId: S.bookId } }));
  $('navPrev').disabled = $('btnPrev').disabled = $('btnFirst').disabled = idx <= 0;
  $('navNext').disabled = $('btnNext').disabled = $('btnLast').disabled = idx >= S.n - 1;
  evict();
  pump();
}
// On phones keep only a window of rendered pages in memory
function evict() {
  if (!isFinite(S.win)) return;
  const lim = S.win + 6;
  for (let i = 0; i < S.n; i++) {
    if (S.urls[i] && Math.abs(i - S.cur) > lim) {
      URL.revokeObjectURL(S.urls[i]); S.urls[i] = undefined; S.blobs[i] = undefined; S.done--;
      const img = S.imgs[i];
      if (img) { img.removeAttribute('src'); img.parentElement.classList.remove('ready'); }
    }
  }
}


/* ---------- Reader mode: Kindle-style, one page at a time, horizontal swipe ---------- */
function buildReader() {
  S.builtMode = 'slide';
  const old = $('book'); if (old) old.innerHTML = '';
  const r = el.reader; r.innerHTML = ''; r.hidden = false;
  S.imgs = [];
  for (let i = 0; i < S.n; i++) {
    const slide = document.createElement('div'); slide.className = 'slide';
    const pg = document.createElement('div'); pg.className = 'page pg'; pg.dataset.n = i + 1;
    const img = new Image(); img.alt = `Page ${i + 1}`; img.draggable = false;
    pg.appendChild(img); slide.appendChild(pg); r.appendChild(slide); S.imgs.push(img);
    if (S.urls[i]) { img.src = S.urls[i]; pg.classList.add('ready'); }
  }
  el.slider.max = S.n; el.pageInput.max = S.n; el.pageTotal.textContent = '/ ' + S.n;
  sizeReader();
  r.scrollLeft = S.cur * r.clientWidth;
  onFlip(Math.min(S.cur, S.n - 1));
  pump();
  window.dispatchEvent(new CustomEvent('flip:built'));
}
function sizeReader() {
  const f = fit('single');
  el.reader.style.setProperty('--pw', f.w + 'px'); el.reader.style.setProperty('--ph', f.h + 'px');
  el.reader.scrollLeft = S.cur * el.reader.clientWidth; // keep the same page after resize/rotate
}
function readerGo(i, smooth = true) {
  i = Math.min(Math.max(i, 0), S.n - 1);
  el.reader.scrollTo({ left: i * el.reader.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
}
let readerRaf = 0;
el.reader.addEventListener('scroll', () => {
  if (S.builtMode !== 'slide') return;
  cancelAnimationFrame(readerRaf);
  readerRaf = requestAnimationFrame(() => {
    const w = el.reader.clientWidth || 1;
    const idx = Math.min(Math.max(Math.round(el.reader.scrollLeft / w), 0), S.n - 1);
    if (idx !== S.cur) onFlip(idx);
  });
}, { passive: true });
// tap the left / right edge to turn the page, like an e-reader
el.reader.addEventListener('click', (e) => {
  const r = el.reader.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width;
  if (x < 0.28) api.prev(); else if (x > 0.72) api.next();
});

const api = {
  next() { S.flip ? S.flip.flipNext() : readerGo(S.cur + 1); },
  prev() { S.flip ? S.flip.flipPrev() : readerGo(S.cur - 1); },
  go(i) { i = Math.min(Math.max(i, 0), S.n - 1); S.flip ? S.flip.flip(i) : readerGo(i); },
};

/* ---------- lazy page rendering ---------- */
async function renderPage(i) {
  if (S.urls[i]) return S.urls[i];
  if (S.inflight[i]) return S.inflight[i];
  const gen = S.gen, pdf = S.pdf, tw = S.tw, th = S.th;
  const p = (async () => {
    const page = await pdf.getPage(i + 1);
    const v1 = page.getViewport({ scale: 1 });
    const s = Math.min(tw / v1.width, th / v1.height);
    const vp = page.getViewport({ scale: s });
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th);
    await page.render({
      canvasContext: ctx, viewport: vp,
      transform: [1, 0, 0, 1, (tw - vp.width) / 2, (th - vp.height) / 2],
    }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    page.cleanup(); c.width = c.height = 0;
    if (gen !== S.gen) return null;
    const url = URL.createObjectURL(blob);
    S.urls[i] = url; S.blobs[i] = blob; S.done++;
    const img = S.imgs[i];
    if (img) { img.src = url; img.parentElement.classList.add('ready'); }
    updatePrep();
    return url;
  })();
  S.inflight[i] = p;
  p.catch(() => { S.failed[i] = true; }).finally(() => { delete S.inflight[i]; });
  return p;
}
function updatePrep() {
  el.prep.textContent = S.done >= S.n || isFinite(S.win) ? '' : `Preparing pages ${S.done}/${S.n}`;
}
async function pump() {
  if (S.pumping || !S.pdf) return;
  S.pumping = true; const gen = S.gen;
  while (gen === S.gen) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < S.n; i++) {
      if (S.urls[i] || S.inflight[i] || S.failed[i]) continue;
      if (Math.abs(i - S.cur) > S.win) continue;
      const d = i >= S.cur - 1 ? Math.abs(i - S.cur) : (S.cur - i) * 1.6 + 1; // look ahead first
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) break;
    try { await renderPage(best); } catch (e) { console.warn('page', best + 1, e); }
  }
  if (gen === S.gen) S.pumping = false;
}

/* ---------- navigation ---------- */
const go = (idx) => S.pdf && api.go(idx);
$('btnNext').onclick = $('navNext').onclick = () => api.next();
$('btnPrev').onclick = $('navPrev').onclick = () => api.prev();
$('btnFirst').onclick = () => go(0);
$('btnLast').onclick = () => go(S.n - 1);
el.slider.oninput = () => { el.pageInput.value = el.slider.value; };
el.slider.onchange = () => go(Number(el.slider.value) - 1);
el.pageInput.onkeydown = (e) => { if (e.key === 'Enter') { go(Number(el.pageInput.value) - 1); el.pageInput.blur(); } };
el.pageInput.onchange = () => go(Number(el.pageInput.value) - 1);

window.addEventListener('keydown', (e) => {
  if (!S.pdf || !document.body.classList.contains('view-reader') || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault(); api.next(); }
  else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); api.prev(); }
  else if (k === 'Home') go(0);
  else if (k === 'End') go(S.n - 1);
  else if (k === 'f' || k === 'F') toggleFullscreen();
  else if (k === 't' || k === 'T') $('btnTheme').click();
  else if (k === 'm' || k === 'M') $('btnMode').click();
});

/* ---------- export: one self-contained HTML file ---------- */
const EXPORT_CSS = `
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(120% 90% at 50% 40%,#241c16,#0e0b09) fixed;color:#f2ebe0;display:flex;flex-direction:column;overflow:hidden}
#stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:36px 56px 8px}
#host{filter:drop-shadow(0 24px 30px rgba(0,0,0,.65))}
.page{background:#fff;overflow:hidden}
#bar{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 14px 14px;flex-wrap:wrap}
#bar button{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:inherit;border-radius:10px;padding:7px 12px;font:inherit;font-size:14px;cursor:pointer}
#bar button:hover{background:rgba(255,255,255,.14)}
#bar button:disabled{opacity:.35;cursor:default}
#slider{width:min(44vw,480px);accent-color:#e8b04a}
#count{font-size:14px;color:#a89c8b;min-width:84px;text-align:center}
#ttl{position:fixed;top:10px;left:0;right:0;text-align:center;font:600 15px Georgia,serif;color:#a89c8b;pointer-events:none;padding:0 70px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:720px){#stage{padding:34px 6px 6px}#slider{width:100%;order:5}}
`;

// This function is serialised into the exported file, so it must be self-contained.
function exportViewer(PAGES, RATIO, TITLE) {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), host = $('host'), slider = $('slider'), count = $('count');
  const N = PAGES.length;
  let flip = null, cur = 0, mode = 'spread', built = null;
  try { mode = localStorage.getItem('fp-mode') || 'spread'; cur = Number(localStorage.getItem('fp-pos:' + TITLE + N)) || 0; } catch (e) {}
  const eff = () => (mode === 'spread' && stage.clientWidth < 560 ? 'single' : mode);
  function fit(m) {
    const cs = getComputedStyle(stage);
    const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const per = m === 'single' ? 1 : 2;
    let w = aw, h = w / (RATIO * per);
    if (h > ah) { h = ah; w = h * RATIO * per; }
    return { w: Math.floor(w), h: Math.floor(h), pw: Math.floor(w / per) };
  }
  function build() {
    if (flip) { try { cur = flip.getCurrentPageIndex(); flip.destroy(); } catch (e) {} }
    const old = $('book'), fresh = document.createElement('div'); fresh.id = 'book'; if (old) old.replaceWith(fresh); else host.appendChild(fresh);
    built = eff(); const f = fit(built);
    host.style.width = f.w + 'px'; host.style.height = f.h + 'px';
    flip = new St.PageFlip(fresh, {
      width: 500, height: Math.round(500 / RATIO), size: 'stretch',
      minWidth: built === 'single' ? f.pw : 100, maxWidth: 4000, minHeight: 100, maxHeight: 6000,
      showCover: true, usePortrait: true, startPage: Math.min(cur, N - 1), drawShadow: true,
      maxShadowOpacity: 0.45, flippingTime: 750, mobileScrollSupport: false, swipeDistance: 25,
    });
    flip.loadFromImages(PAGES);
    flip.on('flip', (e) => ui(e.data));
    ui(Math.min(cur, N - 1));
  }
  function ui(i) {
    cur = i; slider.value = i + 1;
    count.textContent = (i + 1) + ' / ' + N;
    $('prev').disabled = $('first').disabled = i <= 0;
    $('next').disabled = $('last').disabled = i >= N - 1;
    try { localStorage.setItem('fp-pos:' + TITLE + N, String(i)); } catch (e) {}
  }
  const go = (i) => flip.flip(Math.min(Math.max(i, 0), N - 1));
  slider.max = N;
  slider.onchange = () => go(Number(slider.value) - 1);
  $('first').onclick = () => go(0); $('last').onclick = () => go(N - 1);
  $('prev').onclick = () => flip.flipPrev(); $('next').onclick = () => flip.flipNext();
  $('mode').onclick = () => { mode = mode === 'spread' ? 'single' : 'spread'; try { localStorage.setItem('fp-mode', mode); } catch (e) {} build(); };
  $('full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); flip.flipNext(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); flip.flipPrev(); }
    else if (e.key === 'Home') go(0); else if (e.key === 'End') go(N - 1);
    else if (e.key === 'f' || e.key === 'F') $('full').click();
  });
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (eff() !== built) build(); else { const f = fit(built); host.style.width = f.w + 'px'; host.style.height = f.h + 'px'; flip.update(); } }, 80); });
  build();
}

$('btnExport').onclick = async () => {
  if (!S.pdf) return;
  const gen = S.gen;
  try {
    showOverlay('Preparing pages…', 0);
    const lib = await (await fetch('./vendor/page-flip.browser.js')).text();
    const dataUrls = [];
    for (let i = 0; i < S.n; i++) {
      if (gen !== S.gen) throw new Error('cancelled');
      await renderPage(i);
      if (!S.blobs[i]) throw new Error('Page ' + (i + 1) + ' failed to render');
      dataUrls.push(await blobToDataURL(S.blobs[i]));
      showOverlay(`Packing page ${i + 1} of ${S.n}…`, (i + 1) / S.n);
    }
    const safeTitle = S.name.replace(/</g, '&lt;');
    const parts = [
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${EXPORT_CSS}</style></head><body>`,
      `<div id="ttl">${safeTitle}</div><div id="stage"><div id="host"><div id="book"></div></div></div>`,
      `<div id="bar"><button id="first" title="First">⏮</button><button id="prev" title="Previous">←</button><input id="slider" type="range" min="1" max="1" value="1"><button id="next" title="Next">→</button><button id="last" title="Last">⏭</button><span id="count">1</span><button id="mode" title="Single / spread">▯▯</button><button id="full" title="Fullscreen">⛶</button></div>`,
      `<script>`, lib.replace(/<\/script/gi, '<\\/script'), `</script>`,
      `<script>const PAGES=[`,
    ];
    dataUrls.forEach((u, i) => parts.push((i ? ',' : '') + JSON.stringify(u)));
    const titleJson = JSON.stringify(S.name).replace(/</g, '\\u003c');
    parts.push(`];(${exportViewer.toString()})(PAGES,${S.ratio},${titleJson});</script></body></html>`);
    const out = new Blob(parts, { type: 'text/html' });
    const fileName = `${S.name || 'flipbook'}-flipbook.html`;
    let shared = false;
    if (IS_PHONE() && navigator.canShare) {            // phones: use the share sheet (Drive, WhatsApp, Files…)
      const f = new File([out], fileName, { type: 'text/html' });
      if (navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f], title: S.name }); shared = true; }
        catch (e) { if (e.name === 'AbortError') shared = true; }
      }
    }
    if (!shared) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(out); a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    toast(`Flipbook ready (${(out.size / 1048576).toFixed(1)} MB). Open it in any browser.`, 5000);
  } catch (err) {
    if (err.message !== 'cancelled') { console.error(err); toast('Export failed: ' + err.message, 5000); }
  } finally {
    hideOverlay();
  }
};


/* ---------- PWA: install, offline, receive PDFs from the phone's Share menu ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e)));
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('btnInstall').hidden = false; });
window.addEventListener('appinstalled', () => { deferredInstall = null; $('btnInstall').hidden = true; toast('Flip PDF installed'); });
$('btnInstall').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('btnInstall').hidden = true;
};
// expose a tiny hook for automated testing
window.__flippdf = { S, loadFile };
// What the library module needs from the reader
window.FlipReader = {
  loadFile,
  goto: (i) => api.go(i),
  activate: () => layout(),
  get bookId() { return S.bookId; },
  get n() { return S.n; },
  get page() { return S.cur; },
  get mode() { return S.builtMode; },
  pageEl: (i) => (S.imgs[i] ? S.imgs[i].parentElement : null),
  useReaderMode() { if (S.builtMode !== 'slide') { S.mode = 'slide'; store.set('mode', 'slide'); modeIconPath(); if (S.pdf) buildBook(); } },
};

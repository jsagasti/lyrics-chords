'use strict';

/* ============================================================
   Lyrics & Chords — kiosk PWA (Azure Static Web Apps backend)
   - Songs served by /api (Azure Functions + Blob Storage)
   - Search+add songs via LLM (/api/search, /api/addsong)
   - Two-level library tree: Genre -> Artist -> Song
   - Transpose, auto-scroll (text-relative pace), font size
   ============================================================ */

const API = {
  songs: 'api/songs',
  song: (id) => 'api/song/' + encodeURIComponent(id),
  search: 'api/search',
  add: 'api/addsong',
  reorg: 'api/reorganize',
};

const state = {
  songs: [],          // [{id,title,artist,genre,file}]
  current: null,
  currentId: null,
  transpose: 0,
  fontScale: Number(localStorage.getItem('fontScale')) || 1,
  scrolling: false,
  speed: clampSpeed(Number(localStorage.getItem('scrollLevel')) || 6),
  rafId: null,
  scrollAccum: 0,
  pxPerLine: 38,
  collapsed: JSON.parse(localStorage.getItem('collapsedGenres') || '{}'),
};

const SPEED_K = 0.12;

const $ = (id) => document.getElementById(id);
const el = {
  title: $('title'), song: $('song'), stage: $('stage'),
  trVal: $('tr-val'), spdVal: $('spd-val'),
  btnScroll: $('btn-scroll'), drawer: $('drawer'), scrim: $('scrim'),
  list: $('song-list'), filter: $('filter'), foot: $('foot-count'),
  addInput: $('add-input'), addResults: $('add-results'), addStatus: $('add-status'),
};

/* ---------- API helpers + PIN ---------- */
function getPin() { return localStorage.getItem('apiPin') || ''; }
function ensurePin() {
  let pin = getPin();
  if (!pin) {
    pin = window.prompt('Clave de acceso (para agregar/reordenar canciones):') || '';
    if (pin) localStorage.setItem('apiPin', pin);
  }
  return pin;
}
function clearPin() { localStorage.removeItem('apiPin'); }

async function apiPost(url, body) {
  const pin = ensurePin();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-pin': pin },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) { clearPin(); throw new Error('PIN inválido'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------- Chord transposition ---------- */
const SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const PC = { 'C':0,'C#':1,'DB':1,'D':2,'D#':3,'EB':3,'E':4,'FB':4,'E#':5,'F':5,
  'F#':6,'GB':6,'G':7,'G#':8,'AB':8,'A':9,'A#':10,'BB':10,'B':11,'CB':11,'B#':0 };
const CHORD_RE = /^([A-G])([#b]?)([^/\s]*)(?:\/([A-G])([#b]?))?$/;

function transposeNote(root, acc, semitones, useFlat) {
  const key = (root + (acc || '')).toUpperCase();
  const pc = PC[key];
  if (pc === undefined) return root + (acc || '');
  const out = (((pc + semitones) % 12) + 12) % 12;
  return (useFlat ? FLAT : SHARP)[out];
}
function transposeChord(token, semitones, useFlat) {
  if (!semitones) return token;
  const m = token.match(CHORD_RE);
  if (!m) return token;
  const [, root, acc, rest, bassRoot, bassAcc] = m;
  let out = transposeNote(root, acc, semitones, useFlat) + (rest || '');
  if (bassRoot) out += '/' + transposeNote(bassRoot, bassAcc, semitones, useFlat);
  return out;
}
const FLAT_KEYS = new Set([5, 10, 3, 8, 1]);
function preferFlat(song, semitones) {
  const first = song && song.firstChord;
  if (!first) return false;
  const m = first.match(CHORD_RE);
  if (!m) return false;
  const base = PC[(m[1] + (m[2] || '')).toUpperCase()];
  if (base === undefined) return false;
  const pc = (((base + semitones) % 12) + 12) % 12;
  return FLAT_KEYS.has(pc);
}
function useFlat() { return preferFlat(state.current || {}, state.transpose); }

/* ---------- ChordPro parsing ---------- */
function parseChordPro(text) {
  const song = { title: '', artist: '', key: '', firstChord: null, lines: [] };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw;
    const dir = line.match(/^\s*\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}\s*$/);
    if (dir) {
      const name = dir[1].toLowerCase(); const val = dir[2];
      if (name === 'title' || name === 't') song.title = val;
      else if (name === 'artist' || name === 'subtitle' || name === 'st') song.artist = val || song.artist;
      else if (name === 'key') song.key = val;
      else if (name === 'comment' || name === 'c') song.lines.push({ type: 'comment', text: val });
      else if (/^start_of_/.test(name) || /^so[cvbpt]$/.test(name))
        song.lines.push({ type: 'section', text: sectionLabel(name, val) });
      continue;
    }
    if (line.trim() === '') { song.lines.push({ type: 'blank' }); continue; }
    song.lines.push(parseChordLine(line, song));
  }
  if (!song.title) song.title = 'Sin título';
  return song;
}
function sectionLabel(name, val) {
  if (val) return val;
  const map = { soc: 'Estribillo', sov: 'Verso', sob: 'Puente', sop: 'Parte', sot: 'Tab',
    start_of_chorus: 'Estribillo', start_of_verse: 'Verso', start_of_bridge: 'Puente',
    start_of_tab: 'Tab', start_of_part: 'Parte' };
  return map[name] || name.replace(/^start_of_/, '').replace(/_/g, ' ');
}
function parseChordLine(line, song) {
  if (!line.includes('[')) return { type: 'text', text: line };
  const segments = [];
  const re = /\[([^\]]*)\]|([^\[]+)/g;
  let cur = { chord: '', text: '' }; let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined) {
      const chord = m[1].trim();
      if (song.firstChord === null && chord) song.firstChord = chord;
      if (cur.chord || cur.text) segments.push(cur);
      cur = { chord, text: '' };
    } else { cur.text += m[2]; }
  }
  if (cur.chord || cur.text) segments.push(cur);
  return { type: 'chordpair', segments };
}

/* ---------- Rendering ---------- */
function render() {
  const song = state.current;
  el.song.innerHTML = '';
  if (!song) return;
  el.title.textContent = song.artist ? `${song.title} — ${song.artist}` : song.title;
  const useF = useFlat();
  if (song.artist || song.key) {
    const meta = document.createElement('div');
    meta.className = 'song-meta';
    const parts = [];
    if (song.artist) parts.push(song.artist);
    if (song.key) parts.push('Tono: ' + transposeChord(song.key, state.transpose, useF));
    if (state.transpose) parts.push((state.transpose > 0 ? '+' : '') + state.transpose);
    meta.textContent = parts.join('  ·  ');
    el.song.appendChild(meta);
  }
  const frag = document.createDocumentFragment();
  for (const ln of song.lines) frag.appendChild(renderLine(ln, useF));
  el.song.appendChild(frag);
}
function renderLine(ln, useF) {
  const div = document.createElement('div');
  switch (ln.type) {
    case 'blank': div.className = 'song-line blank'; break;
    case 'section': div.className = 'section'; div.textContent = ln.text; break;
    case 'comment': div.className = 'song-line comment'; div.textContent = ln.text; break;
    case 'text': div.className = 'song-line'; div.textContent = ln.text; break;
    case 'chordpair': {
      div.className = 'song-line chordline';
      for (const seg of ln.segments) {
        const col = document.createElement('span'); col.className = 'seg';
        const c = document.createElement('span'); c.className = 'seg-chord';
        c.textContent = seg.chord ? transposeChord(seg.chord, state.transpose, useF) : '';
        const t = document.createElement('span'); t.className = 'seg-lyric';
        t.textContent = seg.text.length ? seg.text : '​';
        col.appendChild(c); col.appendChild(t); div.appendChild(col);
      }
      break;
    }
    default: div.className = 'song-line'; div.textContent = ln.text || '';
  }
  return div;
}

/* ---------- Song loading ---------- */
async function loadIndex() {
  try {
    const res = await fetch(API.songs, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.songs = Array.isArray(data.songs) ? data.songs : [];
    buildList();
    el.foot.textContent = `${state.songs.length} canciones`;
    if (state.songs.length && !state.current) {
      const last = localStorage.getItem('lastSongId');
      const pick = state.songs.find((s) => s.id === last) || state.songs[0];
      loadSong(pick);
    }
  } catch (e) {
    toast('No se pudo cargar la biblioteca');
    el.foot.textContent = 'Sin conexión';
    console.warn('index load failed', e);
  }
}

async function loadSong(entry) {
  try {
    const res = await fetch(API.song(entry.id), { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const song = parseChordPro(text);
    if (!song.title || song.title === 'Sin título') song.title = entry.title || song.title;
    if (!song.artist && entry.artist) song.artist = entry.artist;
    state.current = song;
    state.currentId = entry.id;
    state.transpose = 0;
    el.trVal.textContent = '0';
    stopScroll();
    el.stage.scrollTop = 0;
    render();
    localStorage.setItem('lastSongId', entry.id);
    closeDrawer();
    markActive(entry.id);
  } catch (e) {
    toast('No se pudo abrir "' + (entry.title || entry.id) + '"');
    console.warn('song load failed', e);
  }
}

/* ---------- Library tree (Genre -> Artist -> Song) ---------- */
function buildList() {
  const q = (el.filter.value || '').trim().toLowerCase();
  el.list.innerHTML = '';

  if (q) { renderFiltered(q); return; }

  const genres = new Map();
  for (const s of state.songs) {
    const g = s.genre || 'Sin género';
    const a = s.artist || 'Desconocido';
    if (!genres.has(g)) genres.set(g, new Map());
    const am = genres.get(g);
    if (!am.has(a)) am.set(a, []);
    am.get(a).push(s);
  }

  for (const g of [...genres.keys()].sort(cmp)) {
    const gWrap = document.createElement('div');
    gWrap.className = 'genre';
    const gHead = document.createElement('div');
    gHead.className = 'genre-head';
    const collapsed = !!state.collapsed[g];
    gHead.innerHTML = `<span class="tw">${collapsed ? '▸' : '▾'}</span><span class="gname">${escapeHtml(g)}</span>`;
    gHead.addEventListener('click', () => { state.collapsed[g] = !state.collapsed[g]; persistCollapsed(); buildList(); });
    gWrap.appendChild(gHead);

    if (!collapsed) {
      const am = genres.get(g);
      for (const a of [...am.keys()].sort(cmp)) {
        const aWrap = document.createElement('div');
        aWrap.className = 'artist';
        const aHead = document.createElement('div');
        aHead.className = 'artist-head';
        aHead.textContent = a;
        aWrap.appendChild(aHead);
        for (const s of am.get(a).sort((x, y) => cmp(x.title, y.title))) {
          aWrap.appendChild(songItem(s));
        }
        gWrap.appendChild(aWrap);
      }
    }
    el.list.appendChild(gWrap);
  }
  markActive(state.currentId);
}

function renderFiltered(q) {
  const matches = state.songs.filter((s) =>
    (s.title + ' ' + (s.artist || '') + ' ' + (s.genre || '')).toLowerCase().includes(q));
  for (const s of matches.sort((x, y) => cmp(x.title, y.title))) {
    const item = songItem(s);
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = [s.artist, s.genre].filter(Boolean).join(' · ');
    item.appendChild(sub);
    el.list.appendChild(item);
  }
  if (!matches.length) el.list.innerHTML = '<div class="empty">Sin resultados</div>';
  markActive(state.currentId);
}

function songItem(s) {
  const item = document.createElement('div');
  item.className = 'song-item';
  item.dataset.id = s.id;
  item.appendChild(document.createTextNode(s.title));
  item.addEventListener('click', () => loadSong(s));
  return item;
}

function markActive(id) {
  el.list.querySelectorAll('.song-item').forEach((n) =>
    n.classList.toggle('active', n.dataset.id === id));
}
function cmp(a, b) { return String(a).localeCompare(String(b), 'es'); }
function persistCollapsed() { localStorage.setItem('collapsedGenres', JSON.stringify(state.collapsed)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- Search & add (LLM) ---------- */
async function doSearch() {
  const query = (el.addInput.value || '').trim();
  if (!query) return;
  setAddStatus('Buscando…');
  el.addResults.innerHTML = '';
  try {
    const data = await apiPost(API.search, { query });
    const opts = data.options || [];
    if (!opts.length) { setAddStatus('Sin resultados'); return; }
    setAddStatus('');
    for (const o of opts) {
      const row = document.createElement('div');
      row.className = 'add-opt';
      const label = [o.title, o.artist].filter(Boolean).join(' — ');
      const note = [o.year, o.note].filter(Boolean).join(' · ');
      row.innerHTML = `<div class="add-opt-main">${escapeHtml(label)}</div>${note ? `<div class="add-opt-note">${escapeHtml(note)}</div>` : ''}`;
      row.addEventListener('click', () => addSong(o));
      el.addResults.appendChild(row);
    }
  } catch (e) {
    setAddStatus('Error: ' + e.message);
  }
}

async function addSong(opt) {
  setAddStatus(`Generando "${opt.title}"…`);
  el.addResults.innerHTML = '';
  try {
    const data = await apiPost(API.add, { title: opt.title, artist: opt.artist });
    setAddStatus('');
    el.addInput.value = '';
    await loadIndex();
    if (data.added) loadSong(data.added);
    toast('Agregada: ' + data.added.title);
  } catch (e) {
    setAddStatus('Error: ' + e.message);
  }
}

async function doReorganize() {
  setAddStatus('Reordenando biblioteca…');
  try {
    const data = await apiPost(API.reorg, {});
    setAddStatus('');
    await loadIndex();
    toast(`Reordenado (${data.updated} cambios)`);
  } catch (e) {
    setAddStatus('Error: ' + e.message);
  }
}

function setAddStatus(msg) {
  el.addStatus.hidden = !msg;
  el.addStatus.textContent = msg || '';
}

/* ---------- Auto-scroll ---------- */
function toggleScroll() { state.scrolling ? stopScroll() : startScroll(); }
function measureLineHeight() {
  const cs = getComputedStyle(el.song);
  let lh = parseFloat(cs.lineHeight);
  if (!lh || Number.isNaN(lh)) lh = parseFloat(cs.fontSize) * 1.5;
  return lh || 38;
}
function startScroll() {
  if (state.scrolling) return;
  state.scrolling = true;
  state.pxPerLine = measureLineHeight();
  el.btnScroll.classList.add('on');
  el.btnScroll.innerHTML = '&#10073;&#10073;';
  let last = null;
  const step = (ts) => {
    if (!state.scrolling) return;
    if (last === null) last = ts;
    const dt = (ts - last) / 1000; last = ts;
    const pxPerSec = state.speed * state.pxPerLine * SPEED_K;
    state.scrollAccum += pxPerSec * dt;
    if (state.scrollAccum >= 1) {
      const whole = Math.floor(state.scrollAccum);
      state.scrollAccum -= whole;
      const before = el.stage.scrollTop;
      el.stage.scrollTop = before + whole;
      if (el.stage.scrollTop === before) { stopScroll(); return; }
    }
    state.rafId = requestAnimationFrame(step);
  };
  state.rafId = requestAnimationFrame(step);
}
function stopScroll() {
  state.scrolling = false;
  state.scrollAccum = 0;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  el.btnScroll.classList.remove('on');
  el.btnScroll.innerHTML = '&#9654;';
}

/* ---------- Transpose / speed / font ---------- */
function setTranspose(delta) {
  state.transpose = Math.max(-11, Math.min(11, state.transpose + delta));
  el.trVal.textContent = (state.transpose > 0 ? '+' : '') + state.transpose;
  render();
}
function clampSpeed(v) { return Math.max(1, Math.min(20, v || 1)); }
function setSpeed(delta) {
  state.speed = clampSpeed(state.speed + delta);
  if (el.spdVal) el.spdVal.textContent = state.speed;
  localStorage.setItem('scrollLevel', state.speed);
}
function setFont(delta) {
  state.fontScale = Math.max(0.6, Math.min(2.6, +(state.fontScale + delta).toFixed(2)));
  document.documentElement.style.setProperty('--font-scale', state.fontScale);
  localStorage.setItem('fontScale', state.fontScale);
  if (state.scrolling) state.pxPerLine = measureLineHeight();
}

/* ---------- Drawer ---------- */
function openDrawer() { el.drawer.hidden = false; el.scrim.hidden = false; }
function closeDrawer() { el.drawer.hidden = true; el.scrim.hidden = true; }

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- Wire up ---------- */
function init() {
  document.documentElement.style.setProperty('--font-scale', state.fontScale);
  if (el.spdVal) el.spdVal.textContent = state.speed;

  $('tr-up').addEventListener('click', () => setTranspose(1));
  $('tr-down').addEventListener('click', () => setTranspose(-1));
  $('btn-scroll').addEventListener('click', toggleScroll);
  $('spd-up').addEventListener('click', () => setSpeed(1));
  $('spd-down').addEventListener('click', () => setSpeed(-1));
  $('btn-font-up').addEventListener('click', () => setFont(0.1));
  $('btn-font-down').addEventListener('click', () => setFont(-0.1));
  $('btn-songs').addEventListener('click', openDrawer);
  $('btn-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('btn-refresh').addEventListener('click', () => { toast('Recargando…'); loadIndex(); });
  $('btn-add-search').addEventListener('click', doSearch);
  $('btn-reorg').addEventListener('click', doReorganize);
  el.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  el.filter.addEventListener('input', buildList);

  document.addEventListener('keydown', (e) => {
    if (e.target === el.filter || e.target === el.addInput) return;
    if (e.code === 'Space') { e.preventDefault(); toggleScroll(); }
    else if (e.key === 'ArrowUp') setTranspose(1);
    else if (e.key === 'ArrowDown') setTranspose(-1);
  });

  loadIndex();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);

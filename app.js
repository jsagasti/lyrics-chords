'use strict';

/* ============================================================
   Lyrics & Chords — kiosk PWA
   - Loads ChordPro songs from ./songs/index.json (OTA content)
   - Transpose, auto-scroll w/ speed, font size
   - Offline via service worker; screen kept awake via Wake Lock
   ============================================================ */

const SONGS_INDEX = 'songs/index.json';

const state = {
  songs: [],          // [{id, title, artist, file}]
  current: null,      // parsed song object
  transpose: 0,       // semitones
  fontScale: Number(localStorage.getItem('fontScale')) || 1,
  scrolling: false,
  speed: Number(localStorage.getItem('speed')) || 30,
  rafId: null,
  scrollAccum: 0,
  wakeLock: null,
};

const $ = (id) => document.getElementById(id);
const el = {
  title: $('title'), song: $('song'), stage: $('stage'),
  trVal: $('tr-val'), speed: $('speed'),
  btnScroll: $('btn-scroll'), drawer: $('drawer'), scrim: $('scrim'),
  list: $('song-list'), filter: $('filter'), foot: $('drawer-foot'),
};

/* ---------- Chord transposition ---------- */
const SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const PC = { 'C':0,'C#':1,'DB':1,'D':2,'D#':3,'EB':3,'E':4,'FB':4,'E#':5,'F':5,
  'F#':6,'GB':6,'G':7,'G#':8,'AB':8,'A':9,'A#':10,'BB':10,'B':11,'CB':11,'B#':0 };

// A chord token: root, optional accidental, quality/extensions, optional /bass
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

// Decide flat vs sharp spelling from the resulting key of the first chord.
// Convention: keys of F, Bb, Eb, Ab, Db use flats; everything else sharps.
const FLAT_KEYS = new Set([5, 10, 3, 8, 1]); // F, Bb, Eb, Ab, Db (pitch classes)
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

/* ---------- ChordPro parsing ---------- */
// Returns { title, artist, key, firstChord, lines:[ {type, ...} ] }
function parseChordPro(text) {
  const song = { title: '', artist: '', key: '', firstChord: null, lines: [] };
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');

  for (const raw of rawLines) {
    const line = raw;

    // Directives: {title: ...}, {artist:}, {c: comment}, {soc}, {start_of_chorus}, etc.
    const dir = line.match(/^\s*\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}\s*$/);
    if (dir) {
      const name = dir[1].toLowerCase();
      const val = dir[2];
      if (name === 'title' || name === 't') song.title = val;
      else if (name === 'artist' || name === 'subtitle' || name === 'st') song.artist = val || song.artist;
      else if (name === 'key') song.key = val;
      else if (name === 'comment' || name === 'c') song.lines.push({ type: 'comment', text: val });
      else if (/^start_of_/.test(name) || /^so[cvbpt]$/.test(name))
        song.lines.push({ type: 'section', text: sectionLabel(name, val) });
      // end_of_* and unknown directives are ignored
      continue;
    }

    if (line.trim() === '') { song.lines.push({ type: 'blank' }); continue; }

    song.lines.push(parseChordLine(line, song));
  }

  if (!song.title) song.title = 'Untitled';
  return song;
}

function sectionLabel(name, val) {
  if (val) return val;
  const map = { soc: 'Chorus', sov: 'Verse', sob: 'Bridge', sop: 'Part', sot: 'Tab',
    start_of_chorus: 'Chorus', start_of_verse: 'Verse', start_of_bridge: 'Bridge',
    start_of_tab: 'Tab', start_of_part: 'Part' };
  return map[name] || name.replace(/^start_of_/, '').replace(/_/g, ' ');
}

// Split a line with [Chord] markers into aligned columns.
// Each segment = { chord, text }: the chord sits directly above the text that follows it.
function parseChordLine(line, song) {
  if (!line.includes('[')) return { type: 'text', text: line };

  const segments = [];
  const re = /\[([^\]]*)\]|([^\[]+)/g;
  let cur = { chord: '', text: '' };
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined) {
      const chord = m[1].trim();
      if (song.firstChord === null && chord) song.firstChord = chord;
      if (cur.chord || cur.text) segments.push(cur);
      cur = { chord, text: '' };
    } else {
      cur.text += m[2];
    }
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
    if (song.key) parts.push('Key: ' + transposeChord(song.key, state.transpose, useF));
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
        const col = document.createElement('span');
        col.className = 'seg';
        const c = document.createElement('span');
        c.className = 'seg-chord';
        c.textContent = seg.chord ? transposeChord(seg.chord, state.transpose, useF) : '';
        const t = document.createElement('span');
        t.className = 'seg-lyric';
        t.textContent = seg.text.length ? seg.text : '​';
        col.appendChild(c);
        col.appendChild(t);
        div.appendChild(col);
      }
      break;
    }
    default: div.className = 'song-line'; div.textContent = ln.text || '';
  }
  return div;
}

function useFlat() {
  return preferFlat(state.current || {}, state.transpose);
}

/* ---------- Song loading ---------- */
async function loadIndex() {
  try {
    const res = await fetch(SONGS_INDEX, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.songs = Array.isArray(data) ? data : (data.songs || []);
    buildList();
    el.foot.textContent = `${state.songs.length} songs`;
    if (state.songs.length && !state.current) {
      const last = localStorage.getItem('lastSongId');
      const pick = state.songs.find(s => s.id === last) || state.songs[0];
      loadSong(pick);
    }
  } catch (e) {
    toast('Could not load song list');
    el.foot.textContent = 'Offline / no index';
    console.warn('index load failed', e);
  }
}

async function loadSong(entry) {
  try {
    const res = await fetch(entry.file, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const song = parseChordPro(text);
    if (!song.title || song.title === 'Untitled') song.title = entry.title || song.title;
    if (!song.artist && entry.artist) song.artist = entry.artist;
    state.current = song;
    state.transpose = 0;
    el.trVal.textContent = '0';
    stopScroll();
    el.stage.scrollTop = 0;
    render();
    localStorage.setItem('lastSongId', entry.id);
    closeDrawer();
    markActive(entry.id);
  } catch (e) {
    toast('Could not load "' + (entry.title || entry.id) + '"');
    console.warn('song load failed', e);
  }
}

function buildList() {
  const q = (el.filter.value || '').toLowerCase();
  el.list.innerHTML = '';
  for (const s of state.songs) {
    const hay = (s.title + ' ' + (s.artist || '')).toLowerCase();
    if (q && !hay.includes(q)) continue;
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.innerHTML = `${escapeHtml(s.title)}${s.artist ? `<span class="sub">${escapeHtml(s.artist)}</span>` : ''}`;
    li.addEventListener('click', () => loadSong(s));
    el.list.appendChild(li);
  }
  markActive(localStorage.getItem('lastSongId'));
}

function markActive(id) {
  for (const li of el.list.children) li.classList.toggle('active', li.dataset.id === id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

/* ---------- Auto-scroll ---------- */
function toggleScroll() { state.scrolling ? stopScroll() : startScroll(); }

function startScroll() {
  if (state.scrolling) return;
  state.scrolling = true;
  el.btnScroll.classList.add('on');
  el.btnScroll.innerHTML = '&#10073;&#10073;'; // pause bars
  let last = null;
  const step = (ts) => {
    if (!state.scrolling) return;
    if (last === null) last = ts;
    const dt = (ts - last) / 1000;
    last = ts;
    const pxPerSec = state.speed * 4; // speed 1..100 -> ~4..400 px/s
    state.scrollAccum += pxPerSec * dt;
    if (state.scrollAccum >= 1) {
      const whole = Math.floor(state.scrollAccum);
      state.scrollAccum -= whole;
      const before = el.stage.scrollTop;
      el.stage.scrollTop = before + whole;
      if (el.stage.scrollTop === before) { stopScroll(); return; } // reached bottom
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
  el.btnScroll.innerHTML = '&#9654;'; // play
}

/* ---------- Transpose / font controls ---------- */
function setTranspose(delta) {
  state.transpose = Math.max(-11, Math.min(11, state.transpose + delta));
  el.trVal.textContent = (state.transpose > 0 ? '+' : '') + state.transpose;
  render();
}

function setFont(delta) {
  state.fontScale = Math.max(0.6, Math.min(2.6, +(state.fontScale + delta).toFixed(2)));
  document.documentElement.style.setProperty('--font-scale', state.fontScale);
  localStorage.setItem('fontScale', state.fontScale);
}

/* ---------- Drawer ---------- */
function openDrawer() { el.drawer.hidden = false; el.scrim.hidden = false; el.filter.focus(); }
function closeDrawer() { el.drawer.hidden = true; el.scrim.hidden = true; }

/* ---------- Wake lock (keep screen on) ---------- */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* ignored */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- Wire up ---------- */
function init() {
  document.documentElement.style.setProperty('--font-scale', state.fontScale);
  el.speed.value = state.speed;

  $('tr-up').addEventListener('click', () => setTranspose(1));
  $('tr-down').addEventListener('click', () => setTranspose(-1));
  $('btn-scroll').addEventListener('click', toggleScroll);
  $('btn-font-up').addEventListener('click', () => setFont(0.1));
  $('btn-font-down').addEventListener('click', () => setFont(-0.1));
  $('btn-songs').addEventListener('click', openDrawer);
  $('btn-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('btn-refresh').addEventListener('click', () => { toast('Reloading…'); loadIndex(); });
  el.filter.addEventListener('input', buildList);
  el.speed.addEventListener('input', () => {
    state.speed = Number(el.speed.value);
    localStorage.setItem('speed', state.speed);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === el.filter) return;
    if (e.code === 'Space') { e.preventDefault(); toggleScroll(); }
    else if (e.key === 'ArrowUp')   setTranspose(1);
    else if (e.key === 'ArrowDown') setTranspose(-1);
    else if (e.key === '+' || e.key === '=') setFont(0.1);
    else if (e.key === '-') setFont(-0.1);
  });

  loadIndex();
  requestWakeLock();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

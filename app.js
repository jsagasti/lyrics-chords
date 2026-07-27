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
  del: 'api/deletesong',
  update: 'api/updatesong',
  folders: 'api/folders',
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
  genreOrder: [],
  currentRaw: '',
};

let editorSongId = null;
let menuJustOpenedAt = 0;

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
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const push = (obj, i) => { obj.srcLine = i; song.lines.push(obj); };
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const dir = line.match(/^\s*\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}\s*$/);
    if (dir) {
      const name = dir[1].toLowerCase(); const val = dir[2];
      if (name === 'title' || name === 't') song.title = val;
      else if (name === 'artist' || name === 'subtitle' || name === 'st') song.artist = val || song.artist;
      else if (name === 'key') song.key = val;
      else if (name === 'comment' || name === 'c') push({ type: 'comment', text: val }, i);
      else if (/^start_of_/.test(name) || /^so[cvbpt]$/.test(name))
        push({ type: 'section', text: sectionLabel(name, val) }, i);
      continue;
    }
    if (line.trim() === '') { push({ type: 'blank' }, i); continue; }
    push(parseChordLine(line, song), i);
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
  if (song.source) {
    const src = document.createElement('div');
    src.className = 'song-meta';
    const a = document.createElement('a');
    a.href = song.source; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'srclink';
    a.textContent = 'fuente ↗';
    src.appendChild(a);
    el.song.appendChild(src);
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
  if (ln.srcLine != null) {
    div.dataset.line = ln.srcLine;
    div.classList.add('editable');
    div.addEventListener('click', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('srclink')) return;
      openEditor(ln.srcLine);
    });
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
    state.genreOrder = Array.isArray(data.genreOrder) ? data.genreOrder : [];
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
    state.currentRaw = text;
    const song = parseChordPro(text);
    if (!song.title || song.title === 'Sin título') song.title = entry.title || song.title;
    if (!song.artist && entry.artist) song.artist = entry.artist;
    song.source = entry.source || '';
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

  for (const g of orderedGenres([...genres.keys()])) {
    const gWrap = document.createElement('div');
    gWrap.className = 'genre';
    const gHead = document.createElement('div');
    gHead.className = 'genre-head';
    const collapsed = !!state.collapsed[g];
    gHead.innerHTML = `<span class="tw">${collapsed ? '▸' : '▾'}</span><span class="gname">${escapeHtml(g)}</span>`;
    gHead.addEventListener('click', () => { if (justMenu()) return; state.collapsed[g] = !state.collapsed[g]; persistCollapsed(); buildList(); });
    onLongPress(gHead, (e) => genreMenu(g, e));
    gWrap.appendChild(gHead);

    if (!collapsed) {
      const am = genres.get(g);
      for (const a of [...am.keys()].sort(cmp)) {
        const aWrap = document.createElement('div');
        aWrap.className = 'artist';
        const aHead = document.createElement('div');
        aHead.className = 'artist-head';
        aHead.textContent = a;
        onLongPress(aHead, (e) => artistMenu(g, a, e));
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

// Genre display order: custom (state.genreOrder) first, then the rest alphabetically.
function orderedGenres(keys) {
  const order = state.genreOrder || [];
  const inOrder = order.filter((g) => keys.includes(g));
  const rest = keys.filter((g) => !order.includes(g)).sort(cmp);
  return [...inOrder, ...rest];
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
  item.addEventListener('click', () => { if (justMenu()) return; loadSong(s); });
  onLongPress(item, (e) => songMenu(s, e));
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

/* ---------- Long-press + context menu ---------- */
function pointOf(e) {
  if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX || 120, y: e.clientY || 120 };
}
function onLongPress(node, fn) {
  let timer = null, fired = false, sx = 0, sy = 0;
  const start = (e) => {
    fired = false; const p = pointOf(e); sx = p.x; sy = p.y;
    timer = setTimeout(() => { fired = true; fn(e); }, 500);
  };
  const move = (e) => { const p = pointOf(e); if (Math.abs(p.x - sx) > 10 || Math.abs(p.y - sy) > 10) cancel(); };
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  node.addEventListener('touchstart', start, { passive: true });
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchmove', move, { passive: true });
  node.addEventListener('mousedown', start);
  node.addEventListener('mouseup', cancel);
  node.addEventListener('mouseleave', cancel);
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); fired = true; fn(e); });
  // swallow the click the browser synthesizes right after a long-press
  node.addEventListener('click', (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; } }, true);
}
function justMenu() { return (Date.now() - menuJustOpenedAt) < 700; }

function showMenu(x, y, items) {
  menuJustOpenedAt = Date.now();
  const m = $('ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('div');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); hideMenu(); it.fn(); });
    m.appendChild(b);
  }
  m.hidden = false;
  const w = m.offsetWidth || 220, h = m.offsetHeight || (items.length * 50);
  m.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
}
function hideMenu() { $('ctxmenu').hidden = true; }

function songMenu(s, e) {
  const p = pointOf(e);
  showMenu(p.x, p.y, [
    { label: 'Editar letra/acordes', fn: () => { loadSong(s).then(() => openEditor(0)); } },
    { label: 'Reclasificar', fn: () => reclassifySong(s) },
    { label: 'Borrar canción', danger: true, fn: () => deleteSong(s) },
  ]);
}
function genreMenu(g, e) {
  const p = pointOf(e);
  showMenu(p.x, p.y, [
    { label: 'Renombrar género', fn: () => renameGenre(g) },
    { label: 'Subir', fn: () => moveGenre(g, -1) },
    { label: 'Bajar', fn: () => moveGenre(g, 1) },
    { label: 'Borrar (mover a Otros)', danger: true, fn: () => deleteGenre(g) },
  ]);
}
function artistMenu(g, a, e) {
  const p = pointOf(e);
  showMenu(p.x, p.y, [{ label: 'Renombrar artista', fn: () => renameArtist(g, a) }]);
}

/* ---------- Form modal ---------- */
function showForm(title, fields, onOk) {
  $('form-title').textContent = title;
  const wrap = $('form-fields'); wrap.innerHTML = '';
  const inputs = {};
  for (const f of fields) {
    const l = document.createElement('label'); l.className = 'form-field';
    l.appendChild(document.createTextNode(f.label));
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = f.value || '';
    l.appendChild(inp); wrap.appendChild(l);
    inputs[f.name] = inp;
  }
  const modal = $('formmodal'); modal.hidden = false;
  const okBtn = $('form-ok'), cancelBtn = $('form-cancel');
  const close = () => { modal.hidden = true; okBtn.onclick = null; cancelBtn.onclick = null; };
  okBtn.onclick = async () => {
    const vals = {}; for (const k in inputs) vals[k] = inputs[k].value.trim();
    close();
    try { await onOk(vals); } catch (e) { toast('Error: ' + e.message); }
  };
  cancelBtn.onclick = close;
  const first = fields[0] && inputs[fields[0].name];
  if (first) { first.focus(); first.select(); }
}

/* ---------- Song editor ---------- */
function openEditor(lineIndex) {
  if (!state.currentId) return;
  const ta = $('editor-text');
  ta.value = state.currentRaw || '';
  editorSongId = state.currentId;
  $('editor-title').textContent = 'Editar: ' + (state.current ? state.current.title : '');
  $('editor').hidden = false;
  const lines = ta.value.split('\n');
  let offset = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i++) offset += lines[i].length + 1;
  ta.focus();
  try { ta.setSelectionRange(offset, offset); } catch (_) {}
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (lineIndex - 3) * lh);
}
function closeEditor() { $('editor').hidden = true; editorSongId = null; }
async function saveEditor() {
  const text = $('editor-text').value;
  const id = editorSongId;
  closeEditor();
  try {
    await apiPost(API.update, { id, chordpro: text });
    toast('Guardada');
    await loadIndex();
    const entry = state.songs.find((s) => s.id === id);
    if (entry) loadSong(entry);
  } catch (e) { toast('Error: ' + e.message); }
}

/* ---------- Song ops ---------- */
async function deleteSong(s) {
  if (!window.confirm(`¿Borrar "${s.title}"?`)) return;
  try {
    await apiPost(API.del, { id: s.id });
    if (state.currentId === s.id) { state.current = null; state.currentId = null; el.song.innerHTML = ''; el.title.textContent = ''; }
    await loadIndex();
    toast('Borrada');
  } catch (e) { toast('Error: ' + e.message); }
}
function reclassifySong(s) {
  showForm('Reclasificar canción', [
    { name: 'genre', label: 'Género', value: s.genre || '' },
    { name: 'artist', label: 'Artista', value: s.artist || '' },
  ], async (v) => {
    await apiPost(API.update, { id: s.id, genre: v.genre, artist: v.artist });
    await loadIndex();
    toast('Reclasificada');
  });
}

/* ---------- Folder ops ---------- */
function renameGenre(g) {
  showForm('Renombrar género', [{ name: 'to', label: 'Nuevo nombre', value: g }], async (v) => {
    if (!v.to || v.to === g) return;
    await apiPost(API.folders, { op: 'rename-genre', from: g, to: v.to });
    await loadIndex();
    toast('Género renombrado');
  });
}
function renameArtist(g, a) {
  showForm('Renombrar artista', [{ name: 'to', label: 'Nuevo nombre', value: a }], async (v) => {
    if (!v.to || v.to === a) return;
    await apiPost(API.folders, { op: 'rename-artist', genre: g, from: a, to: v.to });
    await loadIndex();
    toast('Artista renombrado');
  });
}
async function deleteGenre(g) {
  if (!window.confirm(`¿Borrar el género "${g}"? Sus canciones pasan a "Otros".`)) return;
  try {
    await apiPost(API.folders, { op: 'delete-genre', genre: g });
    await loadIndex();
    toast('Movidas a Otros');
  } catch (e) { toast('Error: ' + e.message); }
}
async function moveGenre(g, dir) {
  const keys = [...new Set(state.songs.map((s) => s.genre || 'Sin género'))];
  const genres = orderedGenres(keys);
  const i = genres.indexOf(g), j = i + dir;
  if (i < 0 || j < 0 || j >= genres.length) return;
  [genres[i], genres[j]] = [genres[j], genres[i]];
  state.genreOrder = genres;
  buildList();
  try { await apiPost(API.folders, { op: 'reorder-genres', order: genres }); }
  catch (e) { toast('Error: ' + e.message); }
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
  $('editor-save').addEventListener('click', saveEditor);
  $('editor-cancel').addEventListener('click', closeEditor);
  el.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  el.filter.addEventListener('input', buildList);
  document.addEventListener('click', (e) => {
    const m = $('ctxmenu');
    if (!m.hidden && !m.contains(e.target) && Date.now() - menuJustOpenedAt > 350) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 'Escape') { hideMenu(); closeEditor(); $('formmodal').hidden = true; return; }
    if (e.code === 'Space') { e.preventDefault(); toggleScroll(); }
    else if (e.key === 'ArrowUp') setTranspose(1);
    else if (e.key === 'ArrowDown') setTranspose(-1);
  });

  loadIndex();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);

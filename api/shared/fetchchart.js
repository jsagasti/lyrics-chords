'use strict';
// Fetch a song's chart from a chosen provider (web search), then convert it to inline ChordPro
// DETERMINISTICALLY: chords are placed by their column position over the lyric line (no LLM guessing).
const { webSearchJSON } = require('./openai');

function searchPrompt(title, artist, existingGenres, site, lyricsOnly) {
  const list = (existingGenres && existingGenres.length)
    ? existingGenres.map((g) => `"${g}"`).join(', ')
    : '(ninguno todavía)';
  const how = lyricsOnly
    ? `Es un sitio de SOLO LETRA (sin acordes). Traé la LETRA real tal cual. El campo "raw" tendrá SOLO la letra.`
    : `Traé la LETRA y los ACORDES reales TAL CUAL, CONSERVANDO los espacios/alineación (los acordes van en una línea arriba de la línea de letra, alineados sobre la sílaba). NO reformatees ni muevas los acordes. El campo "raw" tendrá el chart completo con esos espacios.`;
  return `Buscá en la web la canción "${title}"${artist ? ` de "${artist}"` : ''}, priorizando FUERTEMENTE el sitio ${site}. ${how}
Si no la encontrás en ${site}, usá otra fuente confiable.
Devolvé SOLO un JSON válido, sin markdown:
{"title":"...","artist":"...","genre":"...","key":"...","source":"URL exacta","raw":"... con saltos de línea \\n"}
- "genre": elegí el género. Géneros que YA existen: ${list}. Si encaja en alguno, USÁ EXACTAMENTE ese nombre. Si no, usá "Otros".
- "key": tonalidad principal (o "" si es solo letra).`;
}

/* ---------- Latin -> Anglo notation (deterministic) ---------- */
const LATIN = { DO: 'C', RE: 'D', MI: 'E', FA: 'F', SOL: 'G', LA: 'A', SI: 'B' };
function convertRoot(tok) {
  if (!tok) return tok;
  const m = String(tok).match(/^\s*(Sol|Do|Re|Mi|Fa|La|Si)([#b]?)(.*)$/i);
  if (!m) return tok;
  return LATIN[m[1].toUpperCase()] + (m[2] || '') + (m[3] || '');
}
function anglicize(chordpro) {
  let out = chordpro.replace(/\[([^\]]*)\]/g, (full, inner) =>
    '[' + inner.split('/').map(convertRoot).join('/') + ']');
  out = out.replace(/(\{\s*key\s*:\s*)([^}]+)(\})/i, (f, a, k, b) => a + convertRoot(k) + b);
  return out;
}

/* ---------- Deterministic chords-above-lyrics -> inline ChordPro ---------- */
// Accepts Anglo or Latin roots; stricter suffix so lyric words aren't mistaken for chords.
function isChordToken(t) {
  return /^(?:[A-G]|Do|Re|Mi|Fa|Sol|La|Si)(?:#|b)?(?:m|maj|min|dim|aug|sus|add|º|°)?(?:\d{1,2})?(?:sus\d|add\d|maj\d|[#b]\d)?(?:\/(?:[A-G]|Do|Re|Mi|Fa|Sol|La|Si)(?:#|b)?)?$/i.test(t);
}
function isChordLine(line) {
  const toks = line.trim().split(/\s+/).filter(Boolean).filter((t) => !/^\(.*\)$/.test(t));
  return toks.length > 0 && toks.every(isChordToken);
}
const SECTION_RE = /^(intro|verso|estrofa|estribillo|coro|puente|bridge|chorus|verse|final|outro|solo|interludio|pre-?coro|pre-?chorus|instrumental)\b/i;
function isSectionHeader(line) {
  const t = line.trim();
  const clean = t.replace(/[:\[\]().]/g, '').trim();
  if (!SECTION_RE.test(clean)) return false;
  return t.endsWith(':') || /^\[.*\]$/.test(t) || clean.split(/\s+/).length <= 3;
}
// Insert each chord into the lyric line at the column where it appears above.
function mergeChordLine(chordLine, lyricLine) {
  const re = /\S+/g; let m; const placements = [];
  while ((m = re.exec(chordLine)) !== null) {
    if (/^\(.*\)$/.test(m[0])) continue; // skip annotations like (x2)
    placements.push({ col: m.index, chord: m[0] });
  }
  let out = ''; let last = 0;
  for (const p of placements) {
    const col = Math.max(last, Math.min(p.col, lyricLine.length));
    out += lyricLine.slice(last, col) + '[' + p.chord + ']';
    last = col;
  }
  return out + lyricLine.slice(last);
}
function chordOnlyLine(chordLine) {
  const re = /\S+/g; let m; const cs = [];
  while ((m = re.exec(chordLine)) !== null) if (!/^\(.*\)$/.test(m[0])) cs.push(m[0]);
  return cs.map((c) => '[' + c + ']').join(' ');
}
function rawToChordPro(raw, meta) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const out = [`{title: ${meta.title}}`, `{artist: ${meta.artist}}`];
  if (meta.key) out.push(`{key: ${meta.key}}`);
  out.push('');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { out.push(''); continue; }
    if (isSectionHeader(line)) {
      out.push(`{start_of_verse: ${line.trim().replace(/[:\[\]]/g, '').trim()}}`);
      continue;
    }
    if (isChordLine(line)) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== '' && !isChordLine(next) && !isSectionHeader(next)) {
        out.push(mergeChordLine(line, next));
        i++;
      } else {
        out.push(chordOnlyLine(line));
      }
      continue;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function fetchChart(title, artist, opts = {}) {
  const site = opts.site || 'lacuerda.net';
  const found = await webSearchJSON(searchPrompt(title, artist, opts.existingGenres || [], site, !!opts.lyricsOnly));
  if (!found.raw) throw new Error('no se encontró el chart en la web');

  const finalTitle = (found.title || title).trim();
  const finalArtist = (found.artist || artist || 'Desconocido').trim();
  const genre = (found.genre || 'Otros').trim();
  const key = (found.key || '').trim();

  const chordpro = anglicize(rawToChordPro(found.raw, { title: finalTitle, artist: finalArtist, key }));
  return { title: finalTitle, artist: finalArtist, genre, key: convertRoot(key), source: found.source || '', chordpro };
}

module.exports = { fetchChart };

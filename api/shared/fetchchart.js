'use strict';
// Fetch a song's chart from a chosen provider (web search) and convert it to inline ChordPro.
// Shared by /api/addsong (saves) and /api/refetch (preview, no save).
const { webSearchJSON, chatJSON } = require('./openai');

function searchPrompt(title, artist, existingGenres, site, lyricsOnly) {
  const list = (existingGenres && existingGenres.length)
    ? existingGenres.map((g) => `"${g}"`).join(', ')
    : '(ninguno todavía)';
  const how = lyricsOnly
    ? `Es un sitio de SOLO LETRA (sin acordes). Traé la LETRA real tal cual, sin inventar. El campo "raw" tendrá SOLO la letra (sin acordes).`
    : `Traé la LETRA y los ACORDES reales tal cual están (acordes arriba de las líneas de letra). El campo "raw" tendrá el chart completo.`;
  return `Buscá en la web la canción "${title}"${artist ? ` de "${artist}"` : ''}, priorizando FUERTEMENTE el sitio ${site}. ${how}
Si no la encontrás en ${site}, usá otra fuente confiable.
Devolvé SOLO un JSON válido, sin markdown:
{"title":"...","artist":"...","genre":"...","key":"...","source":"URL exacta","raw":"... con saltos de línea \\n"}
- "genre": elegí el género. Géneros que YA existen: ${list}. Si encaja en alguno, USÁ EXACTAMENTE ese nombre. Si no, usá "Otros".
- "key": tonalidad principal (o "" si es solo letra).`;
}

const CONVERT_SYSTEM = `Convertís un chart (formato "acordes arriba de la letra") a formato ChordPro.
Regla clave: cada acorde va entre corchetes [ ] PEGADO (sin espacio) a la sílaba de la letra que está JUSTO DEBAJO de él según su posición horizontal.
Ejemplo:
ENTRADA:
Bm       G        D          A
Ella durmió al calor de las brasas
SALIDA:
[Bm]Ella dur[G]mió al ca[D]lor de las bra[A]sas
Otras reglas:
- NOTACIÓN: usá SIEMPRE notación anglosajona para los acordes Y para el {key:}: C, D, E, F, G, A, B (con # o b). Si la fuente viene en notación latina (Do, Re, Mi, Fa, Sol, La, Si), convertila: Do=C, Re=D, Mi=E, Fa=F, Sol=G, La=A, Si=B (ej. Mib=Eb, Sol=G, Do#=C#, Lam=Am). Mantené los sufijos (m, 7, maj7, sus4, dim, etc.) y el bajo (/G).
- Si la entrada es SOLO LETRA (sin acordes), devolvé solo la letra en ChordPro, SIN inventar acordes.
- Líneas solo de acordes (intro/interludio): "[Bm] [G] [D] [A]".
- Agregá {start_of_verse: Verso 1} / {start_of_chorus: Estribillo} / {start_of_bridge: Puente} donde corresponda.
- Empezá con {title:}, {artist:}, {key:} usando los datos dados.
- No inventes acordes ni letra: usá EXACTAMENTE lo que viene en la entrada.
Devolvé SOLO un JSON: {"chordpro":"...(con \\n)"}`;

async function fetchChart(title, artist, opts = {}) {
  const site = opts.site || 'lacuerda.net';
  const found = await webSearchJSON(searchPrompt(title, artist, opts.existingGenres || [], site, !!opts.lyricsOnly));
  if (!found.raw) throw new Error('no se encontró el chart en la web');

  const finalTitle = (found.title || title).trim();
  const finalArtist = (found.artist || artist || 'Desconocido').trim();
  const genre = (found.genre || 'Otros').trim();
  const key = (found.key || '').trim();

  const convUser = `Datos: title="${finalTitle}", artist="${finalArtist}", key="${key}".\n\nCHART:\n${found.raw}`;
  const conv = await chatJSON(CONVERT_SYSTEM, convUser, { temperature: 0.1 });
  if (!conv.chordpro) throw new Error('no se pudo convertir a ChordPro');

  return { title: finalTitle, artist: finalArtist, genre, key, source: found.source || '', chordpro: conv.chordpro };
}

module.exports = { fetchChart };

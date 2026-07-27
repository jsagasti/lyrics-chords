'use strict';
const { webSearchJSON, chatJSON } = require('../shared/openai');
const { readIndex, writeIndex, writeText } = require('../shared/blob');
const { checkPin, slug, ok, fail } = require('../shared/util');

// Step 1: fetch the real chart from La Cuerda (raw = chords-above-lyrics, as on the site).
function searchPrompt(title, artist) {
  return `Buscá en la web la canción "${title}"${artist ? ` de "${artist}"` : ''}, priorizando FUERTEMENTE lacuerda.net (acordes.lacuerda.net).
Copiá la LETRA y los ACORDES reales de esa fuente, TAL CUAL están (acordes arriba de las líneas de letra). NO inventes ni conviertas nada todavía.
Devolvé SOLO un JSON válido, sin markdown:
{"title":"...","artist":"...","genre":"...","key":"...","source":"URL exacta","raw":"chart completo tal cual, con saltos de línea \\n"}
- "genre": género amplio en español, consistente (ej. "Folclore","Rock Nacional","Pop","Balada","Cumbia").
- "key": tonalidad principal.
- "raw": el chart entero (acordes y letra) tal como aparece en la fuente.`;
}

// Step 2: convert chords-above-lyrics into inline ChordPro (deterministic, no web).
const CONVERT_SYSTEM = `Convertís un chart de acordes (formato "acordes arriba de la letra") a formato ChordPro.
Regla clave: cada acorde va entre corchetes [ ] PEGADO (sin espacio) a la sílaba de la letra que está JUSTO DEBAJO de él según su posición horizontal.
Ejemplo:
ENTRADA:
Bm       G        D          A
Ella durmió al calor de las brasas
SALIDA:
[Bm]Ella dur[G]mió al ca[D]lor de las bra[A]sas

Otras reglas:
- Líneas solo de acordes (intro/interludio/riff): ponelas como "[Bm] [G] [D] [A]" en su propia línea.
- Agregá cabeceras {start_of_verse: Verso 1} / {start_of_chorus: Estribillo} / {start_of_bridge: Puente} donde corresponda.
- Empezá con {title:}, {artist:}, {key:} usando los datos dados.
- No inventes acordes ni letra: usá EXACTAMENTE lo que viene en la entrada.
Devolvé SOLO un JSON: {"chordpro":"...(con \\n)"}`;

module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const title = (req.body && req.body.title || '').trim();
    const artist = (req.body && req.body.artist || '').trim();
    if (!title) return fail(context, 400, 'title requerido');

    // 1) fetch real chart from La Cuerda
    const found = await webSearchJSON(searchPrompt(title, artist));
    if (!found.raw) return fail(context, 502, 'no se encontró el chart en la web');

    const finalTitle = (found.title || title).trim();
    const finalArtist = (found.artist || artist || 'Desconocido').trim();
    const genre = (found.genre || 'Sin género').trim();
    const key = (found.key || '').trim();

    // 2) convert to inline ChordPro
    const convUser = `Datos: title="${finalTitle}", artist="${finalArtist}", key="${key}".\n\nCHART:\n${found.raw}`;
    const conv = await chatJSON(CONVERT_SYSTEM, convUser, { temperature: 0.1 });
    if (!conv.chordpro) return fail(context, 502, 'no se pudo convertir a ChordPro');

    const id = slug(finalTitle, finalArtist);
    await writeText(`songs/${id}.chordpro`, conv.chordpro, 'text/plain; charset=utf-8');

    const idx = await readIndex();
    const entry = {
      id, title: finalTitle, artist: finalArtist, genre,
      key, source: found.source || '', file: `songs/${id}.chordpro`,
    };
    const pos = idx.songs.findIndex((s) => s.id === id);
    if (pos >= 0) idx.songs[pos] = entry; else idx.songs.push(entry);
    await writeIndex(idx);

    ok(context, { added: entry });
  } catch (e) {
    context.log.error('addsong error', e);
    fail(context, 500, e.message);
  }
};

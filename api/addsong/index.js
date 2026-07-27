'use strict';
const { webSearchJSON } = require('../shared/openai');
const { readIndex, writeIndex, writeText } = require('../shared/blob');
const { checkPin, slug, ok, fail } = require('../shared/util');

function buildPrompt(title, artist) {
  return `Buscá en la web la canción "${title}"${artist ? ` de "${artist}"` : ''}, priorizando FUERTEMENTE el sitio lacuerda.net (acordes.lacuerda.net).
Tomá la LETRA y los ACORDES reales de esa fuente (NO los inventes). Si no está en La Cuerda, usá otra fuente confiable de acordes.
Devolvé SOLO un objeto JSON válido, sin texto ni markdown alrededor, con esta forma exacta:
{"title": "...", "artist": "...", "genre": "...", "key": "...", "source": "URL usada", "chordpro": "..."}
Reglas:
- "genre": género musical amplio en español, consistente y reutilizable para agrupar (ej. "Folclore", "Rock Nacional", "Pop", "Balada", "Cumbia", "Trova", "Reggae").
- "artist": el intérprete (normalizado).
- "key": tonalidad principal (ej. "G", "Am", "E").
- "source": la URL exacta de donde sacaste los acordes.
- "chordpro": la canción en formato ChordPro:
    {title: ...}
    {artist: ...}
    {key: ...}
    {start_of_verse: Verso 1}
    Letra con [acordes] inline pegados (sin espacio) JUSTO antes de la sílaba donde suena el acorde.
  Usá secciones {start_of_verse: ...} / {start_of_chorus: Estribillo} / {start_of_bridge: Puente}.`;
}

// POST /api/addsong { title, artist }
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const title = (req.body && req.body.title || '').trim();
    const artist = (req.body && req.body.artist || '').trim();
    if (!title) return fail(context, 400, 'title requerido');

    const data = await webSearchJSON(buildPrompt(title, artist));
    if (!data.chordpro) return fail(context, 502, 'no se obtuvo el ChordPro');

    const finalTitle = (data.title || title).trim();
    const finalArtist = (data.artist || artist || 'Desconocido').trim();
    const genre = (data.genre || 'Sin género').trim();
    const id = slug(finalTitle, finalArtist);

    await writeText(`songs/${id}.chordpro`, data.chordpro, 'text/plain; charset=utf-8');

    const idx = await readIndex();
    const entry = {
      id, title: finalTitle, artist: finalArtist, genre,
      key: data.key || '', source: data.source || '', file: `songs/${id}.chordpro`,
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

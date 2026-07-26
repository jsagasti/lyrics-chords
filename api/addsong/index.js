'use strict';
const { chatJSON } = require('../shared/openai');
const { readIndex, writeIndex, writeText } = require('../shared/blob');
const { checkPin, slug, ok, fail } = require('../shared/util');

const SYSTEM = `Sos un generador de charts de canciones en formato ChordPro para un cancionero.
Dado título y artista, devolvé JSON:
{"title","artist","genre","key","chordpro"}
Reglas:
- "genre": género musical amplio en español, consistente (ej. "Rock Nacional", "Folclore",
  "Pop", "Balada", "Cumbia", "Trova", "Reggae"). Usá nombres reutilizables para agrupar.
- "artist": el intérprete (normalizado).
- "key": tonalidad principal (ej. "G", "Am").
- "chordpro": la canción completa en ChordPro:
    {title: ...}
    {artist: ...}
    {key: ...}
    {start_of_verse: Verso 1}
    Letra con [acordes] inline JUSTO antes de la sílaba donde suena el acorde.
  Usá secciones {start_of_verse: ...} / {start_of_chorus: Estribillo} / {start_of_bridge: Puente}.
  Poné los acordes reales que se tocan habitualmente y la letra real de la canción.
Respondé solo el JSON.`;

// POST /api/addsong { title, artist }
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const title = (req.body && req.body.title || '').trim();
    const artist = (req.body && req.body.artist || '').trim();
    if (!title) return fail(context, 400, 'title requerido');

    const data = await chatJSON(SYSTEM, `Título: ${title}\nArtista: ${artist}`, { temperature: 0.3 });
    if (!data.chordpro) return fail(context, 502, 'el modelo no devolvió chordpro');

    const finalTitle = (data.title || title).trim();
    const finalArtist = (data.artist || artist || 'Desconocido').trim();
    const genre = (data.genre || 'Sin género').trim();
    const id = slug(finalTitle, finalArtist);

    await writeText(`songs/${id}.chordpro`, data.chordpro, 'text/plain; charset=utf-8');

    const idx = await readIndex();
    const entry = { id, title: finalTitle, artist: finalArtist, genre, key: data.key || '', file: `songs/${id}.chordpro` };
    const pos = idx.songs.findIndex((s) => s.id === id);
    if (pos >= 0) idx.songs[pos] = entry; else idx.songs.push(entry);
    await writeIndex(idx);

    ok(context, { added: entry });
  } catch (e) {
    context.log.error('addsong error', e);
    fail(context, 500, e.message);
  }
};

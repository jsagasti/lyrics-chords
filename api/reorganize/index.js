'use strict';
const { chatJSON } = require('../shared/openai');
const { readIndex, writeIndex } = require('../shared/blob');
const { checkPin, ok, fail } = require('../shared/util');

const SYSTEM = `Reclasificá un cancionero en una jerarquía consistente de 2 niveles: Género -> Artista.
Recibís un array de canciones [{id,title,artist,genre}]. Devolvé JSON:
{"songs":[{"id","genre","artist"}]}
Reglas:
- Mantené los "id" EXACTAMENTE como vienen.
- "genre": normalizá a un conjunto chico y consistente de géneros en español, uniendo sinónimos
  (ej. "rock nacional", "Rock Argentino" -> "Rock Nacional"). Agrupá bien para que el árbol quede prolijo.
- "artist": normalizá el nombre del artista (mayúsculas/tildes correctas, sin duplicados por formato).
- Incluí TODAS las canciones recibidas.
Respondé solo el JSON.`;

// POST /api/reorganize -> re-tags every song's genre/artist consistently
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const idx = await readIndex();
    if (!idx.songs.length) return ok(context, { updated: 0, songs: [] });

    const input = idx.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, genre: s.genre || '' }));
    const data = await chatJSON(SYSTEM, JSON.stringify(input), { temperature: 0.1 });
    const byId = new Map((data.songs || []).map((s) => [s.id, s]));

    let updated = 0;
    for (const s of idx.songs) {
      const n = byId.get(s.id);
      if (!n) continue;
      if ((n.genre && n.genre !== s.genre) || (n.artist && n.artist !== s.artist)) updated++;
      if (n.genre) s.genre = n.genre.trim();
      if (n.artist) s.artist = n.artist.trim();
    }
    await writeIndex(idx);
    ok(context, { updated, songs: idx.songs });
  } catch (e) {
    context.log.error('reorganize error', e);
    fail(context, 500, e.message);
  }
};

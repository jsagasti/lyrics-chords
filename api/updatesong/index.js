'use strict';
const { readIndex, writeIndex, writeText } = require('../shared/blob');
const { checkPin, ok, fail } = require('../shared/util');

// POST /api/updatesong { id, chordpro?, title?, artist?, genre?, key? }
// Updates the ChordPro content and/or the index metadata for a song.
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const b = req.body || {};
    const id = (b.id || '').trim();
    if (!id) return fail(context, 400, 'id requerido');

    const idx = await readIndex();
    const entry = idx.songs.find((s) => s.id === id);
    if (!entry) return fail(context, 404, 'la canción no existe');

    if (typeof b.chordpro === 'string' && b.chordpro.trim()) {
      await writeText(`songs/${id}.chordpro`, b.chordpro, 'text/plain; charset=utf-8');
    }
    if (typeof b.title === 'string' && b.title.trim()) entry.title = b.title.trim();
    if (typeof b.artist === 'string' && b.artist.trim()) entry.artist = b.artist.trim();
    if (typeof b.genre === 'string' && b.genre.trim()) entry.genre = b.genre.trim();
    if (typeof b.key === 'string') entry.key = b.key.trim();
    await writeIndex(idx);

    ok(context, { updated: entry });
  } catch (e) {
    context.log.error('updatesong error', e);
    fail(context, 500, e.message);
  }
};

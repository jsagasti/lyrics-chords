'use strict';
const { readIndex, writeIndex } = require('../shared/blob');
const { checkPin, ok, fail } = require('../shared/util');

// POST /api/folders { op, ... }
//  op = 'rename-genre'    { from, to }
//  op = 'rename-artist'   { genre, from, to }
//  op = 'delete-genre'    { genre }           -> songs moved to 'Otros'
//  op = 'reorder-genres'  { order: [genre...] }
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const b = req.body || {};
    const op = b.op;
    const idx = await readIndex();
    let changed = 0;

    if (op === 'rename-genre') {
      const from = (b.from || '').trim(), to = (b.to || '').trim();
      if (!from || !to) return fail(context, 400, 'from/to requeridos');
      for (const s of idx.songs) if ((s.genre || '') === from) { s.genre = to; changed++; }
      if (Array.isArray(idx.genreOrder)) idx.genreOrder = idx.genreOrder.map((g) => (g === from ? to : g));
    } else if (op === 'rename-artist') {
      const genre = (b.genre || '').trim(), from = (b.from || '').trim(), to = (b.to || '').trim();
      if (!from || !to) return fail(context, 400, 'from/to requeridos');
      for (const s of idx.songs) if ((s.genre || '') === genre && (s.artist || '') === from) { s.artist = to; changed++; }
    } else if (op === 'delete-genre') {
      const genre = (b.genre || '').trim();
      if (!genre) return fail(context, 400, 'genre requerido');
      for (const s of idx.songs) if ((s.genre || '') === genre) { s.genre = 'Otros'; changed++; }
      if (Array.isArray(idx.genreOrder)) idx.genreOrder = idx.genreOrder.filter((g) => g !== genre);
    } else if (op === 'reorder-genres') {
      if (!Array.isArray(b.order)) return fail(context, 400, 'order requerido');
      idx.genreOrder = b.order.map((g) => String(g));
      changed = 1;
    } else {
      return fail(context, 400, 'op inválido');
    }

    await writeIndex(idx);
    ok(context, { op, changed, songs: idx.songs, genreOrder: idx.genreOrder || [] });
  } catch (e) {
    context.log.error('folders error', e);
    fail(context, 500, e.message);
  }
};

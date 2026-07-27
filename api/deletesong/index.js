'use strict';
const { readIndex, writeIndex, deleteBlob } = require('../shared/blob');
const { checkPin, ok, fail } = require('../shared/util');

// POST /api/deletesong { id }
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const id = (req.body && req.body.id || '').trim();
    if (!id) return fail(context, 400, 'id requerido');
    await deleteBlob(`songs/${id}.chordpro`);
    const idx = await readIndex();
    const before = idx.songs.length;
    idx.songs = idx.songs.filter((s) => s.id !== id);
    await writeIndex(idx);
    ok(context, { deleted: id, removed: before - idx.songs.length });
  } catch (e) {
    context.log.error('deletesong error', e);
    fail(context, 500, e.message);
  }
};

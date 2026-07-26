'use strict';
const { readIndex } = require('../shared/blob');
const { ok, fail } = require('../shared/util');

// GET /api/songs -> { songs: [{id,title,artist,genre,file}] }
module.exports = async function (context, req) {
  try {
    const idx = await readIndex();
    ok(context, idx);
  } catch (e) {
    context.log.error('songs error', e);
    fail(context, 500, e.message);
  }
};

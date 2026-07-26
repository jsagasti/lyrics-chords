'use strict';
const { readText } = require('../shared/blob');
const { fail } = require('../shared/util');

// GET /api/song/{id} -> ChordPro text
module.exports = async function (context, req) {
  try {
    const id = context.bindingData.id;
    if (!id) return fail(context, 400, 'id required');
    const text = await readText(`songs/${id}.chordpro`);
    if (text === null) return fail(context, 404, 'not found');
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      body: text,
    };
  } catch (e) {
    context.log.error('song error', e);
    fail(context, 500, e.message);
  }
};

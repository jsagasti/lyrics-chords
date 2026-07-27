'use strict';
const { fetchChart } = require('../shared/fetchchart');
const { checkPin, ok, fail } = require('../shared/util');

// POST /api/refetch { title, artist, providerSite?, lyricsOnly? }
// Fetches + converts a chart from a provider and RETURNS it (does NOT save) — used by the
// editor's "retry with LLM" so the user can review before saving.
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const b = req.body || {};
    const title = (b.title || '').trim();
    const artist = (b.artist || '').trim();
    if (!title) return fail(context, 400, 'title requerido');

    const r = await fetchChart(title, artist, { site: b.providerSite, lyricsOnly: b.lyricsOnly });
    ok(context, r);
  } catch (e) {
    context.log.error('refetch error', e);
    fail(context, 500, e.message);
  }
};

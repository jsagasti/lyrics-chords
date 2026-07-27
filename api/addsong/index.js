'use strict';
const { fetchChart } = require('../shared/fetchchart');
const { readIndex, writeIndex, writeText } = require('../shared/blob');
const { checkPin, slug, ok, fail } = require('../shared/util');

// POST /api/addsong { title, artist, providerSite?, lyricsOnly? }
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const b = req.body || {};
    const title = (b.title || '').trim();
    const artist = (b.artist || '').trim();
    if (!title) return fail(context, 400, 'title requerido');

    const idx = await readIndex();
    const existingGenres = [...new Set(idx.songs.map((s) => s.genre).filter(Boolean))];

    const r = await fetchChart(title, artist, {
      site: b.providerSite, lyricsOnly: b.lyricsOnly, existingGenres,
    });

    const id = slug(r.title, r.artist);
    await writeText(`songs/${id}.chordpro`, r.chordpro, 'text/plain; charset=utf-8');

    const entry = {
      id, title: r.title, artist: r.artist, genre: r.genre,
      key: r.key, source: r.source, file: `songs/${id}.chordpro`,
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

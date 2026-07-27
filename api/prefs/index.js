'use strict';
const { readText, writeText } = require('../shared/blob');
const { ok, fail } = require('../shared/util');

// Per-user, per-song playback preferences: { "<songId>": { transpose, speed, fontScale } }.
// Single "default" user for now; becomes prefs/<userId>.json once users exist.
function blobName(req) {
  const user = (req.query && req.query.user || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default';
  return `prefs/${user}.json`;
}

async function readPrefs(name) {
  const t = await readText(name);
  return t ? JSON.parse(t) : {};
}

// GET  /api/prefs               -> { prefs: { songId: {transpose,speed,fontScale} } }
// POST /api/prefs { songId, transpose?, speed?, fontScale? }  -> merges one song
module.exports = async function (context, req) {
  try {
    const name = blobName(req);
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      return ok(context, { prefs: await readPrefs(name) });
    }
    const b = req.body || {};
    const songId = (b.songId || '').trim();
    if (!songId) return fail(context, 400, 'songId requerido');
    const prefs = await readPrefs(name);
    const cur = prefs[songId] || {};
    if (b.transpose !== undefined) cur.transpose = Math.trunc(Number(b.transpose)) || 0;
    if (b.speed !== undefined) cur.speed = Number(b.speed);
    if (b.fontScale !== undefined) cur.fontScale = Number(b.fontScale);
    prefs[songId] = cur;
    await writeText(name, JSON.stringify(prefs), 'application/json; charset=utf-8');
    ok(context, { saved: Object.assign({ songId }, cur) });
  } catch (e) {
    context.log.error('prefs error', e);
    fail(context, 500, e.message);
  }
};

'use strict';

// Simple shared-secret check for the LLM/write endpoints (protects OpenAI credits).
function checkPin(req) {
  const need = process.env.API_PIN;
  if (!need) return true; // no PIN configured -> open
  const got = (req.headers && (req.headers['x-api-pin'] || req.headers['X-Api-Pin'])) ||
              (req.query && req.query.pin);
  return got === need;
}

// URL/blob-safe slug from title + artist.
function slug(...parts) {
  return parts.join(' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'song';
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function ok(context, body) { context.res = { status: 200, headers: JSON_HEADERS, body }; }
function fail(context, status, message) { context.res = { status, headers: JSON_HEADERS, body: { error: message } }; }

module.exports = { checkPin, slug, ok, fail, JSON_HEADERS };

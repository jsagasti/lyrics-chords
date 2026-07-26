'use strict';
const { chatJSON } = require('../shared/openai');
const { checkPin, ok, fail } = require('../shared/util');

const SYSTEM = `Sos un asistente que ayuda a encontrar canciones para un cancionero.
Dado el texto del usuario (nombre de canción, quizá parcial, quizá con artista), devolvé
JSON: {"options":[{"title","artist","year","note"}]} con hasta 6 coincidencias más probables.
- "title": título exacto de la canción.
- "artist": intérprete más conocido (si hay covers, listá las versiones relevantes por separado).
- "year": año aproximado (string), o "".
- "note": aclaración breve para desambiguar (ej. "versión en vivo", "cover de X"), o "".
Ordená de más probable a menos. Respondé solo el JSON.`;

// POST /api/search { query }
module.exports = async function (context, req) {
  try {
    if (!checkPin(req)) return fail(context, 401, 'PIN inválido');
    const query = (req.body && req.body.query || '').trim();
    if (!query) return fail(context, 400, 'query requerido');

    const data = await chatJSON(SYSTEM, query, { temperature: 0.2 });
    const options = Array.isArray(data.options) ? data.options.slice(0, 6) : [];
    ok(context, { options });
  } catch (e) {
    context.log.error('search error', e);
    fail(context, 500, e.message);
  }
};

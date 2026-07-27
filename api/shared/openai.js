'use strict';
const OpenAI = require('openai');

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Chat completion returning parsed JSON (response_format json_object).
async function chatJSON(system, user, { temperature = 0.3 } = {}) {
  const rsp = await client().chat.completions.create({
    model: MODEL(),
    temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return JSON.parse(rsp.choices[0].message.content);
}

// Web-search-grounded JSON: uses the Responses API with the web_search tool so the
// model can fetch real chords/lyrics (e.g. from lacuerda.net) instead of inventing them.
// Extract the first balanced { ... } JSON object from free-form text (tolerates prose/fences).
function extractJSON(text) {
  const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch (_) { return null; } } }
  }
  return null;
}

async function webSearchJSON(prompt, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const rsp = await client().responses.create({
      model: MODEL(),
      tools: [{ type: 'web_search_preview' }],
      input: prompt + (attempt > 0 ? '\n\nIMPORTANTE: respondé ÚNICAMENTE el objeto JSON, sin texto ni explicaciones antes o después.' : ''),
    });
    const obj = extractJSON(rsp.output_text || '');
    if (obj) return obj;
  }
  throw new Error('la búsqueda web no devolvió JSON');
}

module.exports = { client, MODEL, chatJSON, webSearchJSON };

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

module.exports = { client, MODEL, chatJSON };

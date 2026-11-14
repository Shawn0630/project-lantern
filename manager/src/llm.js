// Minimal Gemini REST client (built-in fetch only). Used manager-side for
// the optional LLM polish pass. Returns null when unconfigured.

const DEFAULT_MODEL = 'gemini-2.5-flash';

export function llmConfig(env = process.env) {
  const apiKey = (env.LLM_API_KEY || '').trim();
  const model = (env.LLM_MODEL || DEFAULT_MODEL).trim();
  return { apiKey, model, configured: Boolean(apiKey) };
}

/**
 * Generate text with Gemini. `fetchFn` is injectable for tests.
 * @returns {Promise<string>} model text
 */
export async function generateText(prompt, { apiKey, model, fetchFn = fetch, timeoutMs = 60000 } = {}) {
  if (!apiKey) throw new Error('LLM_API_KEY is not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  if (!text.trim()) throw new Error('Gemini returned empty text');
  return text;
}

/** Build the numbered-lines prompt used for subtitle translation. */
export function buildTranslatePrompt(lines, sourceLang, targetLang) {
  const numbered = lines.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return [
    `Translate the following ${sourceLang} subtitle lines to ${targetLang}.`,
    'Rules:',
    '- Return EXACTLY the same number of lines as the input, in the same order.',
    '- Keep the "N. " numbering on every line.',
    '- Translate naturally for subtitles; keep it concise.',
    '- Do not add explanations, headers, or extra lines.',
    '',
    numbered,
  ].join('\n');
}

/** Parse a numbered-lines translation response back into plain lines. */
export function parseNumberedLines(text, expectedCount) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)[.)]\s*(.*)$/.exec(line);
    if (m) lines[Number(m[1]) - 1] = m[2].trim();
    else lines.push(line);
  }
  const out = lines.filter((l) => l !== undefined);
  if (out.length !== expectedCount) {
    throw new Error(`line count mismatch: expected ${expectedCount}, got ${out.length}`);
  }
  return out;
}

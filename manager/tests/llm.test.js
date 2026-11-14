import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText, llmConfig } from '../src/llm.js';

test('llmConfig reads key/model from env', () => {
  assert.deepEqual(llmConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'm' }), { apiKey: 'k', model: 'm', configured: true });
  assert.equal(llmConfig({}).configured, false);
  assert.equal(llmConfig({ LLM_API_KEY: 'k' }).model, 'gemini-2.5-flash');
});

test('generateText parses a Gemini response', async () => {
  const fakeFetch = async (url, opts) => {
    assert.match(url, /generativelanguage\.googleapis\.com/);
    assert.match(url, /models\/gemini-2\.5-flash:generateContent/);
    const body = JSON.parse(opts.body);
    assert.equal(body.contents[0].parts[0].text, 'hello');
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hi ' }, { text: 'there' }] } }] }),
    };
  };
  const out = await generateText('hello', { apiKey: 'k', model: 'gemini-2.5-flash', fetchFn: fakeFetch });
  assert.equal(out, 'Hi there');
});

test('generateText throws without a key and on HTTP errors', async () => {
  await assert.rejects(generateText('x', { apiKey: '' }), /not configured/);
  const badFetch = async () => ({ ok: false, status: 400, text: async () => 'bad key' });
  await assert.rejects(generateText('x', { apiKey: 'k', model: 'm', fetchFn: badFetch }), /Gemini 400/);
  const emptyFetch = async () => ({ ok: true, json: async () => ({ candidates: [] }) });
  await assert.rejects(generateText('x', { apiKey: 'k', model: 'm', fetchFn: emptyFetch }), /empty text/);
});

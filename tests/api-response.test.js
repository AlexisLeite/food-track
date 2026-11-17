import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiResponse } from '../public/api-response.js';
import { REQUEST_ERROR_MESSAGE } from '../public/errors.js';

test('proxy HTML and empty replies produce understandable errors instead of Safari JSON syntax errors', async () => {
  for (const status of [524, 502, 503, 200]) {
    await assert.rejects(readApiResponse(new Response('<html>Proxy error</html>', { status, headers: { 'Content-Type': 'text/html' } })), error => {
      assert.equal(error.code, 'INVALID_API_RESPONSE');
      assert.equal(error.status, status);
      assert.equal(error.message, REQUEST_ERROR_MESSAGE);
      return true;
    });
  }
  await assert.rejects(readApiResponse(new Response('')), new RegExp(REQUEST_ERROR_MESSAGE));
  for (const body of ['null', '"not an object"', '[]']) await assert.rejects(readApiResponse(new Response(body)), new RegExp(REQUEST_ERROR_MESSAGE));
});

test('transcripts are preserved, API errors are hidden and cancellation remains silent', async () => {
  assert.deepEqual(await readApiResponse(Response.json({ text: 'Dos huevos' })), { text: 'Dos huevos' });
  assert.deepEqual(await readApiResponse(Response.json({ error: 'No se escuchó voz' }, { status: 502 })), { error: REQUEST_ERROR_MESSAGE });
  const abort = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(readApiResponse({ json: async () => { throw abort; } }), error => error === abort);
  await assert.rejects(readApiResponse({ status: 502, json: async () => { throw new SyntaxError('The string did not match the expected pattern.'); } }), new RegExp(REQUEST_ERROR_MESSAGE));
});

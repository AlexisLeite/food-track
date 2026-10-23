import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiResponse } from '../public/api-response.js';

test('proxy HTML and empty replies produce understandable errors instead of Safari JSON syntax errors', async () => {
  for (const [status, message] of [[524, /tardó demasiado/], [502, /no está disponible/], [503, /no está disponible/], [200, /No se pudo leer/]]) {
    await assert.rejects(readApiResponse(new Response('<html>Proxy error</html>', { status, headers: { 'Content-Type': 'text/html' } })), error => {
      assert.equal(error.code, 'INVALID_API_RESPONSE');
      assert.equal(error.status, status);
      assert.match(error.message, message);
      return true;
    });
  }
  await assert.rejects(readApiResponse(new Response('')), /No se pudo leer/);
  for (const body of ['null', '"not an object"', '[]']) await assert.rejects(readApiResponse(new Response(body)), /No se pudo leer/);
});

test('transcripts and API errors are preserved; cancellation remains silent to the caller', async () => {
  assert.deepEqual(await readApiResponse(Response.json({ text: 'Dos huevos' })), { text: 'Dos huevos' });
  assert.deepEqual(await readApiResponse(Response.json({ error: 'No se escuchó voz' }, { status: 502 })), { error: 'No se escuchó voz' });
  const abort = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(readApiResponse({ json: async () => { throw abort; } }), error => error === abort);
  await assert.rejects(readApiResponse({ status: 502, json: async () => { throw new SyntaxError('The string did not match the expected pattern.'); } }), /no está disponible/);
});

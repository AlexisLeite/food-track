import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from './helpers/application.js';
import { today, calculateProfile } from '../server/nutrition.js';
import { REQUEST_ERROR_MESSAGE } from '../public/errors.js';

test('HTTP, extraction polling and chat streams hide causes while server diagnostics retain them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-errors-'));
  const privateCause = 'PRIVATE_PROVIDER_FAILURE';
  const logs = [], originalLog = console.info;
  console.info = line => logs.push(String(line));
  let application, server;
  try {
    application = await createApplication({
      dataDir: dir,
      descriptionAnalyzer: async () => { throw Object.assign(new Error(privateCause), { status: 400, code: privateCause }); },
      assistantRunner: async () => { throw new Error(privateCause); }
    });
    server = application.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie;
    const request = (path, body, extraHeaders = {}) => fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Foodtrack': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const registration = await request('/api/register', { username: 'errors-user', password: 'test-password-123' });
    cookie = registration.headers.get('set-cookie').split(';')[0];
    const { user } = await registration.json();
    await application.db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(user.id);
    const profile = calculateProfile({ height: 175, age: 30, weight: 80, gender: 'male', activity: 'light', targetWeight: 75, targetDate: '2099-01-01' }, today());
    await application.db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify(profile), user.id);

    assert.deepEqual(await (await request('/api/not-a-route')).json(), { error: REQUEST_ERROR_MESSAGE });
    const invalid = await request('/api/login', { username: 'errors-user', password: 'wrong' });
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: REQUEST_ERROR_MESSAGE });

    const { meal } = await (await request('/api/meals/describe', { date: today(), description: 'Dos huevos' })).json();
    const queued = await (await request(`/api/meals/${meal.id}/analyze`, {}, { Prefer: 'respond-async' })).json();
    let result;
    for (let i = 0; i < 100; i++) {
      result = await (await request(`/api/extractions/${queued.job.id}`)).json();
      if (result.job.state === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.job.state, 'failed');
    assert.equal(result.error, REQUEST_ERROR_MESSAGE);
    assert.equal(result.code, undefined);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateCause));
    const stored = await application.db.prepare('SELECT error FROM extraction_jobs WHERE id=?').get(queued.job.id);
    assert.match(stored.error, new RegExp(privateCause));

    const stream = await (await request('/api/chat', { messages: [{ role: 'user', content: '¿Cómo voy?' }] })).text();
    assert.match(stream, new RegExp(REQUEST_ERROR_MESSAGE));
    assert.doesNotMatch(stream, new RegExp(privateCause));
    assert.ok(logs.some(line => line.includes('assistant_request') && line.includes(privateCause)));
    assert.ok(logs.some(line => line.includes('extraction_queue') && line.includes(privateCause)));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await application?.db.close();
    console.info = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});

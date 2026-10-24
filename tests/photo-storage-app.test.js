import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApplication } from '../server/app.js';
import { createPhotoStorage } from '../server/photo-storage.js';

test('accounts and meals stay available in the local database across external photo loss and recovery', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-storage-api-'));
  const settings = { directory: join(dataDir, 'external', 'photos') };
  const photoStorage = createPhotoStorage(dataDir, settings);
  const { app, db } = await createApplication({ dataDir, photoStorage });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const request = async (path, method = 'GET', body) => {
    const headers = { 'X-Foodtrack': '1', ...(cookie ? { Cookie: cookie } : {}) };
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    return fetch(base + path, { method, headers, body });
  };
  try {
    const registered = await request('/api/register', 'POST', { username: 'storage-test', password: 'test-password-123' });
    assert.equal(registered.status, 201);
    cookie = registered.headers.get('set-cookie').split(';')[0];
    const user = (await registered.json()).user;
    db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify({ weight: 80, targetWeight: 75, dailyCalories: 1800 }), user.id);
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).jpeg().toBuffer();
    const upload = async () => {
      const form = new FormData();
      form.append('date', '2026-10-24');
      form.append('photo', new Blob([image], { type: 'image/jpeg' }), 'meal.jpg');
      const response = await request('/api/meals', 'POST', form);
      assert.equal(response.status, 201);
      return (await response.json()).meal;
    };
    const original = await upload();
    assert.equal((await request(original.photoUrl)).status, 200);
    assert.equal((await readdir(join(dataDir, 'photos'))).length, 0);
    settings.mountPoint = dataDir; settings.mountUuid = 'missing-test-filesystem';
    assert.equal((await request('/api/me')).status, 200);
    const history = await request('/api/day?date=2026-10-24');
    assert.equal(history.status, 200);
    assert.equal((await history.json()).meals.length, 1);
    assert.equal((await request(original.photoUrl)).status, 404);
    const offline = await upload();
    assert.equal((await request(offline.photoUrl)).status, 200);
    db.prepare('UPDATE meals SET selected=? WHERE id=?').run(JSON.stringify({ name: 'Comida', portion: 'Un plato', calories: 200 }), original.id);
    const repeat = await request(`/api/meals/${original.id}/repeat`, 'POST', { date: '2026-10-25' });
    assert.equal(repeat.status, 201);
    assert.equal((await repeat.json()).meal.photoUrl, null);
    delete settings.mountPoint; delete settings.mountUuid;
    assert.equal((await photoStorage.flush()).moved, 1);
    assert.equal((await request(original.photoUrl)).status, 200);
    assert.equal((await request(offline.photoUrl)).status, 200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM meals').get().n, 3);
    assert.ok((await stat(join(dataDir, 'foodtrack.sqlite'))).isFile());
    await assert.rejects(readFile(join(settings.directory, 'foodtrack.sqlite')), { code: 'ENOENT' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../server/app.js';

test('cambio de contraseña respalda datos, conserva cuentas y revoca solo sesiones de alexis', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'foodtrack-password-'));
  const { app, db } = await createApplication({ dataDir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, cookie) => fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Foodtrack': '1', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const invoke = password => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/change-password.mjs', import.meta.url))], {
    env: { ...process.env, FOODTRACK_DB: join(dataDir, 'foodtrack.sqlite') },
    input: password, encoding: 'utf8',
  });
  try {
    const oldPassword = 'password anterior alexis';
    const alexis = await request('/api/register', { username: 'alexis', password: oldPassword });
    const other = await request('/api/register', { username: 'otro', password: 'password de otro usuario' });
    assert.equal(alexis.status, 201);
    assert.equal(other.status, 201);
    const cookie = alexis.headers.get('set-cookie').split(';')[0];
    const otherCookie = other.headers.get('set-cookie').split(';')[0];
    const id = db.prepare('SELECT id FROM users WHERE username=?').get('alexis').id;
    db.prepare('INSERT INTO meals VALUES(?,?,?,?,?,?)').run('meal', id, '2026-10-19', 'photo.jpg', null, 'original');
    const before = db.prepare('SELECT * FROM meals').all();
    const otherBefore = db.prepare('SELECT * FROM users WHERE username=?').get('otro');
    for (const invalid of ['short', 'x'.repeat(129)]) assert.equal(invoke(invalid).status, 1);
    assert.equal((await request('/api/me', null, cookie)).status, 200);
    const result = invoke('contraseña nueva de prueba');
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await request('/api/login', { username: 'alexis', password: oldPassword })).status, 401);
    assert.equal((await request('/api/login', { username: 'alexis', password: 'contraseña nueva de prueba' })).status, 200);
    assert.equal((await request('/api/me', null, cookie)).status, 401);
    assert.equal((await request('/api/me', null, otherCookie)).status, 200);
    assert.deepEqual(db.prepare('SELECT * FROM meals').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM users WHERE username=?').get('otro'), otherBefore);
    const snapshot = join(dataDir, readdirSync(dataDir).find(name => name.includes('.before-password-')));
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    const backup = new DatabaseSync(snapshot, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(backup.prepare('SELECT * FROM meals').all(), before);
      assert.equal(backup.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);
    } finally { backup.close(); }
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

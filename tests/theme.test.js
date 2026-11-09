import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from './helpers/application.js';
test('themes default to dark, persist across sessions and restarts, and stay isolated by account', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-theme-'));
  let current, server;
  const start = async () => {
    current = await createApplication({
      dataDir
    });
    server = current.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
  };
  const request = async (path, {
    method = 'GET',
    cookie,
    body
  } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        'X-Foodtrack': '1',
        'Content-Type': 'application/json',
        ...(cookie ? {
          Cookie: cookie
        } : {})
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {})
    });
    return {
      status: res.status,
      body: await res.json(),
      cookie: res.headers.get('set-cookie')?.split(';')[0]
    };
  };
  try {
    // An existing account gains the new default without changing its other columns.
    const legacy = new DatabaseSync(join(dataDir, 'foodtrack.sqlite'));
    legacy.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,profile TEXT,enable_codex_extraction INTEGER NOT NULL DEFAULT 0)');
    await legacy.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('legacy', 'legacy', 'unchanged', null, 1);
    legacy.close();
    await start();
    assert.deepEqual({
      ...(await current.db.prepare('SELECT * FROM users WHERE id=?').get('legacy'))
    }, {
      id: 'legacy',
      username: 'legacy',
      password: 'unchanged',
      profile: null,
      enable_codex_extraction: 1,
      theme: 'dark'
    });
    const a = await request('/api/register', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'long-password-a'
      }
    });
    const b = await request('/api/register', {
      method: 'POST',
      body: {
        username: 'bobby',
        password: 'long-password-b'
      }
    });
    assert.equal(a.body.user.theme, 'dark');
    assert.equal(b.body.user.theme, 'dark');
    assert.equal((await request('/api/preferences', {
      method: 'PUT',
      body: {
        theme: 'light'
      }
    })).status, 401);
    assert.equal((await request('/api/preferences', {
      method: 'PUT',
      cookie: a.cookie,
      body: {
        theme: 'invalid'
      }
    })).status, 400);
    assert.equal((await request('/api/preferences', {
      method: 'PUT',
      cookie: a.cookie,
      body: {
        theme: 'light',
        userId: b.body.user.id
      }
    })).status, 200);
    assert.equal((await request('/api/me', {
      cookie: b.cookie
    })).body.user.theme, 'dark');
    await new Promise(resolve => server.close(resolve));
    await current.db.close();
    await start();
    assert.equal((await request('/api/me', {
      cookie: a.cookie
    })).body.user.theme, 'light');
    const login = await request('/api/login', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'long-password-a'
      }
    });
    assert.equal(login.body.user.theme, 'light');
    assert.equal((await request('/api/preferences', {
      method: 'PUT',
      cookie: login.cookie,
      body: {
        theme: 'dark'
      }
    })).body.theme, 'dark');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    current?.db.close();
    await rm(dataDir, {
      recursive: true,
      force: true
    });
  }
});

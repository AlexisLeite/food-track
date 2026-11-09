import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync, randomBytes } from 'node:crypto';
import { createApplication } from './helpers/application.js';
test('password changes verify current password, enforce confirmation, isolate accounts and revoke other sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-password-'));
  const {
    app,
    db
  } = await createApplication({
    dataDir: dir
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const req = async (path, {
    method = 'POST',
    cookie,
    body
  } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
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
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0]
    };
  };
  try {
    const salt = randomBytes(16).toString('hex');
    await db.prepare('INSERT INTO users(id,username,password,enable_codex_extraction) VALUES(?,?,?,1)').run('initial', 'initial-demo', `${salt}:${scryptSync('initial', salt, 64).toString('hex')}`);
    assert.equal((await req('/api/register', {
      body: {
        username: 'short-demo',
        password: 'initial'
      }
    })).status, 400);
    const login = await req('/api/login', {
      body: {
        username: 'initial-demo',
        password: 'initial'
      }
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.canChat, true);
    const second = await req('/api/login', {
      body: {
        username: 'initial-demo',
        password: 'initial'
      }
    });
    const other = await req('/api/register', {
      body: {
        username: 'other-demo',
        password: 'other-password'
      }
    });
    const otherBefore = await db.prepare('SELECT * FROM users WHERE id=?').get(other.body.user.id);
    const original = await db.prepare('SELECT * FROM users WHERE id=?').get('initial');
    const body = {
      currentPassword: 'initial',
      newPassword: 'new-password-123',
      confirmPassword: 'new-password-123',
      username: 'other-demo',
      userId: other.body.user.id
    };
    assert.equal((await req('/api/password', {
      method: 'PUT',
      body
    })).status, 401);
    for (const bad of [{
      currentPassword: 'wrong'
    }, {
      confirmPassword: 'different'
    }, {
      newPassword: 'short',
      confirmPassword: 'short'
    }, {
      currentPassword: ''
    }]) assert.equal((await req('/api/password', {
      method: 'PUT',
      cookie: login.cookie,
      body: {
        ...body,
        ...bad
      }
    })).status, 400);
    assert.deepEqual(await db.prepare('SELECT * FROM users WHERE id=?').get('initial'), original);
    assert.equal((await req('/api/password', {
      method: 'PUT',
      cookie: login.cookie,
      body
    })).status, 200);
    assert.equal((await req('/api/me', {
      method: 'GET',
      cookie: login.cookie
    })).status, 200);
    assert.equal((await req('/api/me', {
      method: 'GET',
      cookie: second.cookie
    })).status, 401);
    assert.equal((await req('/api/me', {
      method: 'GET',
      cookie: other.cookie
    })).status, 200);
    assert.equal((await req('/api/login', {
      body: {
        username: 'initial-demo',
        password: 'initial'
      }
    })).status, 401);
    assert.equal((await req('/api/login', {
      body: {
        username: 'initial-demo',
        password: body.newPassword
      }
    })).status, 200);
    const updated = await db.prepare('SELECT * FROM users WHERE id=?').get('initial');
    assert.notEqual(updated.password, original.password);
    assert.ok(!updated.password.includes(body.newPassword));
    assert.deepEqual({
      ...updated,
      password: original.password
    }, {
      ...original
    });
    assert.deepEqual(await db.prepare('SELECT * FROM users WHERE id=?').get(other.body.user.id), otherBefore);
  } finally {
    await new Promise(r => server.close(r));
    await db.close();
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

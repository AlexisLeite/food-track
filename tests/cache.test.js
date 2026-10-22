import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUserCache, isCancelledError } from '../public/cache.js';
const storage = () => { const data = new Map(); return { getItem: k => data.get(k) || null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };

test('cache survives reloads, stays account-scoped, and passes saved ETags for revalidation', async () => {
  const disk = storage(), url = '/api/day?date=2026-10-18';
  const first = createUserCache({ storage: disk, gcTime: 0 });
  first.setUser('alice');
  await first.fetch(url, async () => ({ data: { meals: ['alice meal'] }, etag: 'revision-1' }));
  first.persist(); first.destroy();
  const restored = createUserCache({ storage: disk, gcTime: 0 });
  try {
    restored.setUser('bob'); assert.equal(restored.peek(url), undefined);
    restored.setUser('alice'); assert.deepEqual(restored.peek(url), { meals: ['alice meal'] });
    await restored.fetch(url, async ({ known }) => { assert.equal(known.etag, 'revision-1'); return { data: { meals: ['new meal'] }, etag: 'revision-2' }; });
    assert.deepEqual(restored.peek(url), { meals: ['new meal'] });
    const copy = restored.peek(url); copy.meals.push('outside mutation');
    assert.deepEqual(restored.peek(url), { meals: ['new meal'] });
    restored.invalidate('day', '2026-10-18'); assert.equal(restored.peek(url), undefined);
    await restored.fetch('/api/history?days=7', async () => ({ data: { days: [] }, etag: 'h' }));
    restored.invalidate('history'); assert.equal(restored.peek('/api/history?days=7'), undefined);
    restored.persist(); restored.clear(true);
    assert.equal(disk.getItem('foodtrack:cache:v3:alice'), null);
  } finally { restored.destroy(); }
});
test('cache cancellation prevents responses from a previous account reappearing', async () => {
  const cache = createUserCache({ storage: storage(), gcTime: 0 });
  cache.setUser('alice'); let finish;
  const pending = cache.fetch('/api/day?date=2026-10-18', () => new Promise(resolve => { finish = resolve; }));
  cache.setUser('bob');
  await assert.rejects(pending, error => isCancelledError(error));
  finish({ data: { meals: ['alice secret'] }, etag: 'a' });
  await Promise.resolve(); assert.equal(cache.peek('/api/day?date=2026-10-18'), undefined);
  cache.destroy();
});
test('expired or malformed localStorage is ignored', () => {
  const disk = storage(); disk.setItem('foodtrack:cache:v3:alice', '{broken');
  const cache = createUserCache({ storage: disk, gcTime: 0, maxAge: 1000 });
  cache.setUser('alice'); assert.equal(disk.getItem('foodtrack:cache:v3:alice'), null); cache.destroy();
  disk.setItem('foodtrack:cache:v3:alice', JSON.stringify({ version: 3, owner: 'alice', savedAt: Date.now() - 2000, state: { queries: [], mutations: [] } }));
  const expired = createUserCache({ storage: disk, gcTime: 0, maxAge: 1000 });
  expired.setUser('alice'); assert.equal(disk.getItem('foodtrack:cache:v3:alice'), null); expired.destroy();
});

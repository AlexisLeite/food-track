import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPhotoStorage } from '../server/photo-storage.js';

async function fixture(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-photos-'));
  const settings = { directory: join(dataDir, 'external', 'photos') };
  const photos = createPhotoStorage(dataDir, settings);
  await photos.init();
  try { await fn({ photos, dataDir, settings }); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

test('writes photos directly to external storage without local replicas', () => fixture(async ({ photos, dataDir, settings }) => {
  await photos.write('meal.jpg', Buffer.from('photo'));
  assert.equal(await readFile(join(settings.directory, 'meal.jpg'), 'utf8'), 'photo');
  assert.deepEqual(await readdir(join(dataDir, 'photos')), []);
  assert.equal((await stat(join(settings.directory, 'meal.jpg'))).mode & 0o777, 0o600);
  assert.equal((await photos.read('meal.jpg')).toString(), 'photo');
  await photos.withFile('meal.jpg', async filename => {
    assert.ok(filename.endsWith('/meal.jpg'));
    assert.equal(await readFile(filename, 'utf8'), 'photo');
  });
}));

test('missing disk stores new photos locally and moves them when available', () => fixture(async ({ photos, dataDir, settings }) => {
  settings.mountPoint = dataDir;
  settings.mountUuid = 'missing-test-filesystem';
  await photos.write('offline.jpg', Buffer.from('offline image'));
  assert.equal((await photos.read('offline.jpg')).toString(), 'offline image');
  await assert.rejects(stat(settings.directory), { code: 'ENOENT' });
  assert.equal((await photos.flush()).moved, 0);
  delete settings.mountPoint; delete settings.mountUuid;
  assert.equal((await photos.flush()).moved, 1);
  assert.deepEqual(await readdir(join(dataDir, 'photos')), []);
  assert.equal((await photos.read('offline.jpg')).toString(), 'offline image');
  assert.equal((await photos.flush()).moved, 0);
}));

test('unavailable historical photos do not hide newly captured photos', () => fixture(async ({ photos, dataDir, settings }) => {
  await photos.write('old.jpg', Buffer.from('old image'));
  settings.mountPoint = dataDir; settings.mountUuid = 'missing-test-filesystem';
  await assert.rejects(photos.read('old.jpg'), { code: 'ENOENT' });
  await photos.write('new.jpg', Buffer.from('new image'));
  assert.equal((await photos.read('new.jpg')).toString(), 'new image');
  delete settings.mountPoint; delete settings.mountUuid;
  await photos.flush();
  assert.equal((await photos.read('old.jpg')).toString(), 'old image');
  assert.equal((await photos.read('new.jpg')).toString(), 'new image');
}));

test('deletions made offline are applied before queued transfers', () => fixture(async ({ photos, dataDir, settings }) => {
  await photos.write('deleted.jpg', Buffer.from('archive copy'));
  settings.mountPoint = dataDir; settings.mountUuid = 'missing-test-filesystem';
  await photos.remove('deleted.jpg');
  delete settings.mountPoint; delete settings.mountUuid;
  await photos.flush();
  await assert.rejects(stat(join(settings.directory, 'deleted.jpg')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(dataDir, 'photos')), []);
}));

test('failed external writes fall back locally, including after a process restart', () => fixture(async ({ photos, dataDir, settings }) => {
  const blocked = join(dataDir, 'blocked');
  await writeFile(blocked, 'not a directory');
  settings.directory = join(blocked, 'photos');
  await photos.write('retry.jpg', Buffer.from('saved locally'));
  assert.equal(await readFile(join(dataDir, 'photos', 'retry.jpg'), 'utf8'), 'saved locally');
  settings.directory = join(dataDir, 'external', 'photos');
  const restarted = createPhotoStorage(dataDir, settings);
  assert.equal((await restarted.flush()).moved, 1);
  assert.equal((await restarted.read('retry.jpg')).toString(), 'saved locally');
}));

test('recovery does not move a local image while an analyzer is using its path', () => fixture(async ({ photos, dataDir, settings }) => {
  await writeFile(join(dataDir, 'photos', 'analyzing.jpg'), 'image');
  await photos.withFile('analyzing.jpg', async filename => {
    assert.equal((await photos.flush()).moved, 0);
    assert.equal(await readFile(filename, 'utf8'), 'image');
  });
  assert.equal((await photos.flush()).moved, 1);
  assert.equal(await readFile(join(settings.directory, 'analyzing.jpg'), 'utf8'), 'image');
}));

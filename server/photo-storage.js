import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openExternalDirectory, storagePath } from './external-storage.js';
import { logExecution } from './execution-log.js';

const ignoreMissing = error => { if (error.code !== 'ENOENT') throw error; };

export function createPhotoStorage(dataDir, settings = process.env.FOODTRACK_PHOTOS_DIR ? {
  directory: process.env.FOODTRACK_PHOTOS_DIR,
  mountPoint: process.env.FOODTRACK_MEDIA_MOUNT,
  mountUuid: process.env.FOODTRACK_MEDIA_UUID,
} : null) {
  const local = join(dataDir, 'photos');
  const readers = new Map();
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const valid = name => {
    if (!name || basename(name) !== name || !name.endsWith('.jpg')) throw new Error('Invalid photo name');
    return name;
  };
  const external = async () => {
    if (!settings) return null;
    try { return await openExternalDirectory(settings); }
    catch (error) {
      logExecution('photo_storage', { outcome: 'local_fallback', code: error.code || error.name });
      return null;
    }
  };
  async function publish(directory, name, bytes) {
    const temporary = join(directory, '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, join(directory, name));
      const handle = await open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } finally { await unlink(temporary).catch(ignoreMissing); }
  }
  async function read(name, action) {
    valid(name);
    readers.set(name, (readers.get(name) || 0) + 1);
    const directory = await external();
    let file, filename;
    try {
      if (directory) {
        try { filename = storagePath(directory, name); file = await open(filename, 'r'); }
        catch (error) { if (!['ENOENT', 'EIO', 'ENODEV'].includes(error.code)) throw error; }
      }
      if (!file) { filename = join(local, name); file = await open(filename, 'r'); }
      return await action(file, filename);
    } finally {
      await file?.close(); await directory?.close();
      const remaining = readers.get(name) - 1;
      if (remaining) readers.set(name, remaining); else readers.delete(name);
    }
  }
  const store = {
    async init() { await mkdir(local, { recursive: true, mode: 0o700 }); },
    read(name) { return read(name, file => file.readFile()); },
    withFile(name, action) { return read(name, (_file, filename) => action(filename)); },
    write(name, bytes) {
      valid(name);
      return serial(async () => {
        const directory = await external();
        try {
          if (directory) {
            try { await publish(storagePath(directory), name, bytes); return; }
            catch (error) { logExecution('photo_storage', { outcome: 'local_fallback', code: error.code || error.name }); }
          }
          await publish(local, name, bytes);
        } finally { await directory?.close(); }
      });
    },
    async copy(source, destination) { await store.write(destination, await store.read(source)); },
    remove(name) {
      valid(name);
      return serial(async () => {
        // Persist deletion intent while the disk is absent; recovery must not
        // resurrect a photo from an interrupted transfer.
        await publish(local, name + '.deleted', Buffer.alloc(0));
        await unlink(join(local, name)).catch(ignoreMissing);
        const directory = await external();
        try {
          if (directory) {
            await unlink(storagePath(directory, name)).catch(ignoreMissing);
            await directory.sync();
            await unlink(join(local, name + '.deleted'));
          }
        } finally { await directory?.close(); }
      });
    },
    flush() {
      return serial(async () => {
        const directory = await external();
        if (!directory) return { moved: 0 };
        let moved = 0;
        try {
          const entries = await readdir(local);
          for (const name of entries.filter(name => name.endsWith('.jpg.deleted'))) {
            await unlink(storagePath(directory, name.slice(0, -8))).catch(ignoreMissing);
            await directory.sync();
            await unlink(join(local, name));
          }
          for (const name of entries.filter(name => name.endsWith('.jpg'))) {
            if (readers.has(name)) continue;
            if (entries.includes(name + '.deleted')) { await unlink(join(local, name)).catch(ignoreMissing); continue; }
            await publish(storagePath(directory), name, await readFile(join(local, name)));
            await unlink(join(local, name));
            moved++;
          }
          return { moved };
        } finally { await directory.close(); }
      });
    },
    start(intervalMs = 30_000) {
      const tick = () => store.flush().then(result => {
        if (result.moved) logExecution('photo_storage', { moved: result.moved });
      }).catch(error => logExecution('photo_storage', { outcome: 'retry_pending', code: error.code || error.name }));
      void tick();
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  return store;
}

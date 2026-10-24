import { copyFile, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeAudioCaptures } from './audio-capture.js';
import { logExecution } from './execution-log.js';
import { openExternalDirectory, storagePath } from './external-storage.js';

const transfers = new Map();

async function transfer(dataDir) {
  const pending = join(dataDir, 'audio-debug', 'pending');
  let settings, entries;
  try {
    settings = JSON.parse(await readFile(join(dataDir, 'audio-debug', 'persistent.json'), 'utf8'));
    entries = await readdir(pending);
  } catch (error) { if (error.code === 'ENOENT') return { archived: 0 }; throw error; }
  const destination = await openExternalDirectory(settings);
  if (!destination) return { archived: 0, unavailable: true };
  let archived = 0;
  try {
    const target = storagePath(destination);
    for (const name of entries.filter(name => name.endsWith('.json'))) {
      const metadataPath = join(pending, name);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (typeof metadata.file !== 'string' || basename(metadata.file) !== metadata.file || metadata.file === '.' || metadata.file === '..') throw new Error('Invalid audio filename');
      const source = join(pending, metadata.file);
      if (activeAudioCaptures.has(source)) continue;
      if ((await stat(source)).size !== metadata.bytes) throw new Error('Incomplete local audio');
      // Retry safely after an interrupted transfer. Only completed pairs leave
      // the local queue; metadata is published last in the archive.
      for (const [src, destinationName] of [[source, metadata.file], [metadataPath, name]]) {
        const temporary = join(target, '.' + randomUUID() + '.tmp');
        try {
          await copyFile(src, temporary);
          const output = await open(temporary, 'r');
          try { await output.sync(); } finally { await output.close(); }
          await rename(temporary, join(target, destinationName));
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
      await destination.sync();
      // Remove metadata first. A crash here can retain an orphan local audio,
      // but never a queued record whose only audio has already been removed.
      await unlink(metadataPath);
      await unlink(source);
      archived++;
    }
    return { archived };
  } finally { await destination.close(); }
}

export function flushAudioArchive(dataDir) {
  if (!transfers.has(dataDir)) transfers.set(dataDir, transfer(dataDir).finally(() => transfers.delete(dataDir)));
  return transfers.get(dataDir);
}

export function startAudioArchiveWorker(dataDir, intervalMs = 30_000) {
  const tick = () => flushAudioArchive(dataDir).then(result => {
    if (result.archived) logExecution('audio_archive', { archived: result.archived });
  }).catch(error => logExecution('audio_archive', { outcome: 'retry_pending', code: error.code || error.name }));
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

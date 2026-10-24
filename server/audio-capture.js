import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

// In-flight recordings stay local until their transcription result is written.
export const activeAudioCaptures = new Set();

// Diagnostic capture explicitly enabled for an account, once or continuously.
export async function captureDiagnosticAudio({ dataDir, userId, buffer, mimeType, requestId }) {
  const directory = join(dataDir, 'audio-debug');
  let persistent;
  try { persistent = JSON.parse(await readFile(join(directory, 'persistent.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const continuous = persistent?.userId === '*' || persistent?.userId === userId;
  const id = randomUUID();
  let claimed = null;
  if (!continuous) {
    const flag = join(directory, 'next.json');
    let settings;
    try { settings = JSON.parse(await readFile(flag, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (settings.userId !== userId) return null;
    claimed = join(directory, `${id}.pending.json`);
    try { await rename(flag, claimed); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const destination = continuous ? join(directory, 'pending') : directory;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const extension = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }[mimeType.split(';')[0]] || 'audio';
  const file = join(destination, `${id}.${extension}`);
  if (continuous) activeAudioCaptures.add(file);
  try {
    await writeFile(file, buffer, { mode: 0o600, flag: 'wx', flush: true });
    await writeFile(join(destination, `${id}.json`), JSON.stringify({ userId, requestId, mimeType, bytes: buffer.length, createdAt: new Date().toISOString(), status: 'received', transcription: null, file: `${id}.${extension}` }, null, 2), { mode: 0o600, flag: 'wx', flush: true });
    if (claimed) await unlink(claimed);
    return file;
  } catch (error) {
    // Keep the original bytes if metadata fails; preserve the claim for diagnosis.
    throw error;
  }
}
export async function armAudioCapture(dataDir, userId) {
  const directory = join(dataDir, 'audio-debug');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'next.json'), JSON.stringify({ userId, armedAt: new Date().toISOString() }), { mode: 0o600 });
}

export async function enableContinuousAudioCapture(dataDir, userId, destination, { mountPoint, mountUuid } = {}) {
  const directory = join(dataDir, 'audio-debug');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${randomUUID()}.config.tmp`);
  await writeFile(temporary, JSON.stringify({ userId, directory: destination, mountPoint, mountUuid, enabledAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, join(directory, 'persistent.json'));
}

export async function recordAudioResult(file, { text, errorCode }) {
  const metadataPath = file.slice(0, -extname(file).length) + '.json';
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const result = { ...metadata, completedAt: new Date().toISOString(),
    status: errorCode ? 'failed' : 'transcribed', transcription: typeof text === 'string' ? text : null,
    errorCode: errorCode || null };
  const temporary = metadataPath + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, metadataPath);
  activeAudioCaptures.delete(file);
}

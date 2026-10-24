import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { activeAudioCaptures, captureDiagnosticAudio, enableContinuousAudioCapture, recordAudioResult } from '../server/audio-capture.js';
import { flushAudioArchive } from '../server/audio-archive.js';

async function fixture(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-archive-test-'));
  const archive = join(dataDir, 'external', 'audio');
  const input = { dataDir, userId: 'alexis', buffer: Buffer.from('original recording'), mimeType: 'audio/webm', requestId: 'request-1' };
  try { await fn({ dataDir, archive, input }); }
  finally {
    for (const file of activeAudioCaptures) if (file.startsWith(dataDir + '/')) activeAudioCaptures.delete(file);
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('missing external volume preserves local bytes and results, then transfers without duplicates', () => fixture(async ({ dataDir, archive, input }) => {
  await enableContinuousAudioCapture(dataDir, '*', archive, { mountPoint: join(dataDir, 'external'), mountUuid: 'missing-test-filesystem' });
  const file = await captureDiagnosticAudio(input);
  await recordAudioResult(file, { text: 'Dos huevos' });
  assert.deepEqual(await flushAudioArchive(dataDir), { archived: 0, unavailable: true });
  assert.deepEqual(await readFile(file), input.buffer);
  await assert.rejects(stat(join(dataDir, 'external')), { code: 'ENOENT' });
  // A regular directory target makes recovery portable to non-root test hosts.
  await enableContinuousAudioCapture(dataDir, '*', archive);
  assert.deepEqual(await flushAudioArchive(dataDir), { archived: 1 });
  assert.deepEqual(await readFile(join(archive, basename(file))), input.buffer);
  const metadata = JSON.parse(await readFile(join(archive, basename(file).replace('.webm', '.json')), 'utf8'));
  assert.equal(metadata.transcription, 'Dos huevos');
  assert.equal(metadata.requestId, 'request-1');
  assert.equal(metadata.status, 'transcribed');
  assert.equal((await stat(join(archive, basename(file)))).mode & 0o777, 0o600);
  assert.equal((await stat(archive)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(dataDir, 'audio-debug', 'pending')), []);
  assert.deepEqual(await flushAudioArchive(dataDir), { archived: 0 });
  assert.equal((await readdir(archive)).length, 2);
}));

test('an existing unmounted directory is never used as the external volume', () => fixture(async ({ dataDir, archive, input }) => {
  await enableContinuousAudioCapture(dataDir, '*', archive, { mountPoint: dataDir, mountUuid: 'missing-test-filesystem' });
  const file = await captureDiagnosticAudio(input);
  await recordAudioResult(file, { errorCode: 'AUDIO_NO_SPEECH' });
  assert.equal((await flushAudioArchive(dataDir)).unavailable, true);
  await assert.rejects(stat(archive), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(file.replace('.webm', '.json'), 'utf8')).errorCode, 'AUDIO_NO_SPEECH');
}));

test('transfers wait for in-flight results and serialize concurrent flushes', () => fixture(async ({ dataDir, archive, input }) => {
  await enableContinuousAudioCapture(dataDir, '*', archive);
  const file = await captureDiagnosticAudio(input);
  assert.equal((await flushAudioArchive(dataDir)).archived, 0);
  await recordAudioResult(file, { errorCode: 'TRANSCRIPTION_FAILED' });
  const results = await Promise.all([flushAudioArchive(dataDir), flushAudioArchive(dataDir)]);
  assert.deepEqual(results, [{ archived: 1 }, { archived: 1 }]);
  assert.equal((await readdir(archive)).length, 2);
  assert.equal(JSON.parse(await readFile(join(archive, basename(file).replace('.webm', '.json')), 'utf8')).errorCode, 'TRANSCRIPTION_FAILED');
}));

test('failed archive writes retain the local pair and retry after destination recovery', () => fixture(async ({ dataDir, archive, input }) => {
  const blocked = join(dataDir, 'blocked');
  await writeFile(blocked, 'not a directory');
  await enableContinuousAudioCapture(dataDir, '*', join(blocked, 'audio'));
  const file = await captureDiagnosticAudio(input);
  await recordAudioResult(file, { text: 'Una manzana' });
  await assert.rejects(flushAudioArchive(dataDir));
  assert.deepEqual(await readFile(file), input.buffer);
  assert.equal(JSON.parse(await readFile(file.replace('.webm', '.json'), 'utf8')).transcription, 'Una manzana');
  await enableContinuousAudioCapture(dataDir, '*', archive);
  assert.equal((await flushAudioArchive(dataDir)).archived, 1);
}));

test('restart recovers unfinished captures from the durable local queue', () => fixture(async ({ dataDir, archive, input }) => {
  await enableContinuousAudioCapture(dataDir, '*', archive);
  const file = await captureDiagnosticAudio(input);
  // A fresh process has no active transcription for this durable record.
  activeAudioCaptures.delete(file);
  assert.equal((await flushAudioArchive(dataDir)).archived, 1);
  assert.deepEqual(await readFile(join(archive, basename(file))), input.buffer);
  assert.equal(JSON.parse(await readFile(join(archive, basename(file).replace('.webm', '.json')), 'utf8')).status, 'received');
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armAudioCapture, captureDiagnosticAudio } from '../server/audio-capture.js';

test('diagnostic audio capture saves only the next upload for the armed account', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-capture-'));
  const input = { dataDir, userId: 'alexis', buffer: Buffer.from('original bytes'), mimeType: 'audio/webm', requestId: 'request-1' };
  try {
    assert.equal(await captureDiagnosticAudio(input), null);
    await armAudioCapture(dataDir, 'alexis');
    assert.equal(await captureDiagnosticAudio({ ...input, userId: 'someone-else' }), null);
    const copies = await Promise.all([captureDiagnosticAudio(input), captureDiagnosticAudio(input)]);
    assert.equal(copies.filter(Boolean).length, 1);
    const file = copies.find(Boolean);
    assert.deepEqual(await readFile(file), input.buffer);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await captureDiagnosticAudio(input), null);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('continuous capture retains every upload for the configured user on the configured destination', async () => {
  const { enableContinuousAudioCapture } = await import('../server/audio-capture.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-continuous-'));
  const destination = await mkdtemp(join(tmpdir(), 'foodtrack-secondary-'));
  const input = { dataDir, userId: 'alexis', buffer: Buffer.from('original bytes'), mimeType: 'audio/mp4', requestId: 'r1' };
  try {
    await enableContinuousAudioCapture(dataDir, 'alexis', destination);
    assert.equal(await captureDiagnosticAudio({ ...input, userId: 'other' }), null);
    const files = await Promise.all([captureDiagnosticAudio(input), captureDiagnosticAudio(input), captureDiagnosticAudio(input)]);
    assert.equal(new Set(files).size, 3);
    for (const file of files) {
      assert.ok(file.startsWith(destination + '/'));
      assert.ok(file.endsWith('.m4a'));
      assert.deepEqual(await readFile(file), input.buffer);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.ok(await captureDiagnosticAudio(input));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test('all-user archive pairs concurrent uploads with their own transcript or failure', async () => {
  const { enableContinuousAudioCapture, recordAudioResult } = await import('../server/audio-capture.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-all-audio-'));
  const destination = join(dataDir, 'archive');
  try {
    await enableContinuousAudioCapture(dataDir, '*', destination);
    const input = { dataDir, buffer: Buffer.from('original audio'), mimeType: 'audio/webm' };
    const [first, second] = await Promise.all([
      captureDiagnosticAudio({ ...input, userId: 'alexis', requestId: 'first' }),
      captureDiagnosticAudio({ ...input, userId: 'aline', requestId: 'second' })
    ]);
    await Promise.all([
      recordAudioResult(first, { text: 'Dos huevos' }),
      recordAudioResult(second, { errorCode: 'AUDIO_NO_SPEECH' })
    ]);
    const metadata = async file => JSON.parse(await readFile(file.replace(/\.webm$/, '.json'), 'utf8'));
    assert.equal((await metadata(first)).transcription, 'Dos huevos');
    assert.equal((await metadata(first)).userId, 'alexis');
    assert.equal((await metadata(first)).status, 'transcribed');
    assert.equal((await metadata(second)).transcription, null);
    assert.equal((await metadata(second)).userId, 'aline');
    assert.equal((await metadata(second)).errorCode, 'AUDIO_NO_SPEECH');
    assert.deepEqual(await readFile(second), input.buffer);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

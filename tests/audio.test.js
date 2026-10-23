import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { transcribeAudio } from '../server/audio.js';

test('temporary audio is removed after transcription success and failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-audio-test-'));
  const previous = process.env.WHISPER_PYTHON;
  try {
    for (const fail of [false, true]) {
      const trace = join(dir, `trace-${fail}.json`);
      const python = join(dir, `python-${fail}`);
      await writeFile(python, `#!/usr/bin/node\nconst fs=require('node:fs');\nconst file=process.argv[3];fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({file,exists:fs.existsSync(file)}));\n${fail ? 'process.exit(1);' : 'console.log(JSON.stringify({text:"Sin aceite"}));'}\n`, { mode: 0o700 });
      process.env.WHISPER_PYTHON = python;
      if (fail) await assert.rejects(transcribeAudio(Buffer.from('test audio')));
      else assert.deepEqual(await transcribeAudio(Buffer.from('test audio')), { text: 'Sin aceite' });
      const recorded = JSON.parse(await readFile(trace, 'utf8'));
      assert.equal(recorded.exists, true);
      await assert.rejects(access(recorded.file), { code: 'ENOENT' });
      await assert.rejects(access(dirname(recorded.file)), { code: 'ENOENT' });
    }
  } finally {
    if (previous === undefined) delete process.env.WHISPER_PYTHON;
    else process.env.WHISPER_PYTHON = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('empty and excessive transcripts have distinct diagnostic codes without logging their contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-audio-result-'));
  const previous = process.env.WHISPER_PYTHON, original = console.info;
  const logs = [];
  console.info = line => logs.push(JSON.parse(line));
  try {
    for (const [text, code] of [['', 'AUDIO_NO_SPEECH'], ['a'.repeat(1501), 'AUDIO_TRANSCRIPT_TOO_LONG']]) {
      const python = join(dir, code);
      await writeFile(python, `#!/usr/bin/node\nconsole.log(${JSON.stringify(JSON.stringify({ text, durationSeconds: 6, speechSeconds: 0 }))});\n`, { mode: 0o700 });
      process.env.WHISPER_PYTHON = python;
      await assert.rejects(transcribeAudio(Buffer.from('test')), error => error.code === code && error.status === 422);
      assert.ok(logs.some(log => log.phase === 'failed' && log.reason === code));
      assert.ok(logs.some(log => log.phase === 'transcribed' && log.textLength === text.length));
    }
    assert.ok(logs.every(log => !Object.hasOwn(log, 'text')));
  } finally {
    console.info = original;
    if (previous === undefined) delete process.env.WHISPER_PYTHON; else process.env.WHISPER_PYTHON = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

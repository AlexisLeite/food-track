import { executionLogger } from './execution-log.js';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
let busy = false;
export async function transcribeAudio(buffer) {
  const log = executionLogger('audio_execution');
  if (busy) { log('rejected', { reason: 'busy' }); throw Object.assign(new Error('Hay otro audio en proceso. Volvé a intentar en un momento.'), { status: 429 }); }
  busy = true; log('started', { bytes: buffer.length });
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'foodtrack-audio-'));
    const file = join(dir, 'recording.audio'); await writeFile(file, buffer, { mode: 0o600 });
    const output = await new Promise((resolve, reject) => {
      const python = process.env.WHISPER_PYTHON || fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
      const child = spawn(python, [fileURLToPath(new URL('./transcribe.py', import.meta.url)), file], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let text = '', timedOut = false, diagnosticBytes = 0;
      child.once('spawn', () => log('spawned', { pid: child.pid }));
      child.stdout.on('data', chunk => { if (text.length < 32000) text += chunk.toString(); });
      child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; });
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 90000);
      child.on('error', () => { log('spawn_failed'); clearTimeout(timer); reject(new Error('La transcripción no está disponible en el servidor.')); });
      child.on('close', (code, signal) => { log('process_exit', { exitCode: code, signal, timedOut, diagnosticBytes }); clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error('No se pudo transcribir. Probá con un audio más corto o escribí la corrección.')); });
    });
    const result = JSON.parse(output);
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    log('transcribed', { textLength: text.length,
      ...(Number.isFinite(result.durationSeconds) ? { durationSeconds: result.durationSeconds } : {}),
      ...(Number.isFinite(result.speechSeconds) ? { speechSeconds: result.speechSeconds } : {}),
      ...(Number.isFinite(result.rms) ? { rms: result.rms } : {}),
      ...(Number.isFinite(result.peak) ? { peak: result.peak } : {}),
      ...(typeof result.vadFallback === 'boolean' ? { vadFallback: result.vadFallback } : {}) });
    if (!text) throw Object.assign(new Error('No se escuchó voz. Probá de nuevo o escribí la corrección.'), { code: 'AUDIO_NO_SPEECH', status: 422 });
    if (text.length > 1500) throw Object.assign(new Error('El audio es demasiado largo. Grabá una corrección más corta.'), { code: 'AUDIO_TRANSCRIPT_TOO_LONG', status: 422 });
    log('completed');
    return { text };
  } catch (error) {
    log('failed', { reason: ['AUDIO_NO_SPEECH', 'AUDIO_TRANSCRIPT_TOO_LONG'].includes(error.code) ? error.code : error instanceof SyntaxError ? 'invalid_json' : 'transcription_error' });
    throw error;
  } finally { busy = false; if (dir) await rm(dir, { recursive: true, force: true }); }
}

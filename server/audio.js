import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
let busy = false;
export async function transcribeAudio(buffer) {
  if (busy) throw Object.assign(new Error('Hay otro audio en proceso. Volvé a intentar en un momento.'), { status: 429 });
  busy = true;
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'foodtrack-audio-'));
    const file = join(dir, 'recording.audio'); await writeFile(file, buffer, { mode: 0o600 });
    const output = await new Promise((resolve, reject) => {
      const python = process.env.WHISPER_PYTHON || fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
      const child = spawn(python, [fileURLToPath(new URL('./transcribe.py', import.meta.url)), file], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let text = '';
      child.stdout.on('data', chunk => { if (text.length < 32000) text += chunk.toString(); });
      child.stderr.resume();
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 90000);
      child.on('error', () => { clearTimeout(timer); reject(new Error('La transcripción no está disponible en el servidor.')); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error('No se pudo transcribir. Probá con un audio más corto o escribí la corrección.')); });
    });
    const result = JSON.parse(output);
    if (!result.text?.trim()) throw new Error('No se escuchó voz. Probá de nuevo o escribí la corrección.');
    if (result.text.length > 1500) throw new Error('El audio es demasiado largo. Grabá una corrección más corta.');
    return { text: result.text };
  } finally { busy = false; if (dir) await rm(dir, { recursive: true, force: true }); }
}

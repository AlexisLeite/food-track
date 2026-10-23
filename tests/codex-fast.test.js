import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzePhoto, analyzeDescription, estimateMissingMacros } from '../server/codex.js';

test('every Codex evaluation explicitly requests Fast even when global config is ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-fast-test-'));
  const original = process.env.CODEX_BIN;
  try {
    const cli = join(dir, 'codex');
    await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
for (const value of ['service_tier="fast"', 'features.fast_mode=true']) {
  if (!args.some((arg, i) => arg === '-c' && args[i + 1] === value)) process.exit(2);
}
if (!args.includes('--ignore-user-config')) process.exit(3);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
const result = schema.required.includes('description')
  ? { description: 'Comida', options: [{ name: 'Huevos', portion: 'Dos unidades', calories: 142, protein: 12, fat: 10, carbs: 1, details: 'Estimación' }] }
  : { options: [{ index: 0, protein: 12, fat: 10, carbs: 1 }] };
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result)));
`, { mode: 0o700 });
    process.env.CODEX_BIN = cli;
    assert.equal((await analyzePhoto(join(dir, 'photo.jpg'))).options[0].calories, 142);
    assert.equal((await analyzePhoto(join(dir, 'photo.jpg'), 'Dos huevos, sin aceite')).options.length, 1);
    assert.equal((await analyzeDescription('Dos huevos')).options[0].calories, 142);
    assert.equal((await analyzeDescription('Dos huevos', 'Sin aceite')).options.length, 1);
    assert.equal((await estimateMissingMacros(join(dir, 'photo.jpg'), [{ index: 0, calories: 142 }], '') )[0].protein, 12);
  } finally {
    if (original === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = original;
    await rm(dir, { recursive: true, force: true });
  }
});

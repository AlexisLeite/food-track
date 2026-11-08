import {withTokenTracking} from '../server/token-usage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzePhoto, analyzeDescription, estimateMissingMacros, analyzeWorkout } from '../server/codex.js';

test('food evaluations request Fast and workout estimates use standard service even when global config is ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-fast-test-'));
  const original = process.env.CODEX_BIN;
  try {
    const cli = join(dir, 'codex');
    await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
const workout = !!schema.properties.options?.items?.properties?.activities;
for (const value of workout ? ['service_tier="default"', 'features.fast_mode=false', 'model_reasoning_effort="low"'] : ['service_tier="fast"', 'features.fast_mode=true', 'model_reasoning_effort="low"']) {
  if (!args.some((arg, i) => arg === '-c' && args[i + 1] === value)) process.exit(2);
}
if (!args.includes('--ignore-user-config') || !args.includes('--json')) process.exit(3);
const result = workout ? {options:[1,2,3].map(i=>({name:'Moderado '+i,details:'Supuesto',activities:[{name:'Caminar',minutes:30,met:4}]}))} : schema.required.includes('description')
  ? { description: 'Comida', options: [{ name: 'Huevos', portion: 'Dos unidades', calories: 142, protein: 12, fat: 10, carbs: 1, details: 'Estimación' }] }
  : { options: [{ index: 0, protein: 12, fat: 10, carbs: 1 }] };
process.stdin.resume();
process.stdin.on('end', () => {fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,output_tokens:200,cached_input_tokens:800,reasoning_output_tokens:50}}));});
`, { mode: 0o700 });
    process.env.CODEX_BIN = cli;
    const records=[];
    await withTokenTracking({record:r=>records.push(structuredClone(r))},async()=>{
    assert.equal((await analyzePhoto(join(dir, 'photo.jpg'))).options[0].calories, 142);
    assert.equal((await analyzePhoto(join(dir, 'photo.jpg'), 'Dos huevos, sin aceite')).options.length, 1);
    assert.equal((await analyzeDescription('Dos huevos')).options[0].calories, 142);
    assert.equal((await analyzeWorkout('Caminé 30 minutos')).options[0].activities[0].minutes,30);
    assert.equal((await analyzeDescription('Dos huevos', 'Sin aceite')).options.length, 1);
    assert.equal((await estimateMissingMacros(join(dir, 'photo.jpg'), [{ index: 0, calories: 142 }], '') )[0].protein, 12);
    });
    const final=records.filter(r=>r.status==='completed');assert.equal(final.length,6);
    assert.ok(final.every(r=>r.usage?.total===1200 && r.usage.cached===800));
    assert.equal(final.filter(r=>r.source==='workout').length,1);
    assert.ok(final.every(r=>r.speed===(r.source==='workout'?'standard':'fast')));
  } finally {
    if (original === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = original;
    await rm(dir, { recursive: true, force: true });
  }
});

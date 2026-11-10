import { codexServer } from '../server/codex-server.js';
import {withTokenTracking} from '../server/token-usage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzePhoto, analyzeDescription, estimateMissingMacros, analyzeWorkout } from '../server/codex.js';

test('all evaluations reuse one server with isolated Terra fast threads and low reasoning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-fast-test-'));
  const original = process.env.CODEX_BIN, originalHome = process.env.CODEX_HOME;
  try {
    const cli = join(dir, 'codex');
    await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const config = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8');
for (const value of ['shell_tool = false','apply_patch_freeform = false','project_doc_max_bytes = 0','[agents]','[skills.bundled]','include_instructions = false','code_mode_host = true']) if (!config.includes(value)) process.exit(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'starts'))}, 'started\\n');
let seq = 0;
const threads = new Set(), emit = value => console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line', line => {
 const msg = JSON.parse(line), p = msg.params;
 if (!msg.id) return;
 if (msg.method === 'initialize') emit({id:msg.id,result:{}});
 if (msg.method === 'thread/start') {
  if(p.model !== 'gpt-6.1-terra' || p.serviceTier !== 'fast' || p.ephemeral !== true || p.config.web_search !== 'live' || p.config.features.fast_mode !== true || p.config.features.code_mode_host !== true || !p.baseInstructions.includes('Tu única herramienta permitida es búsqueda web') || !p.baseInstructions.includes('Uruguay') || !p.baseInstructions.includes('fabricante') || p.baseInstructions.length > 1000) process.exit(3);
  const id = 'thread-' + (++seq); threads.add(id); emit({id:msg.id,result:{thread:{id}}});
 }
 if (msg.method === 'turn/start') {
  if(p.effort !== 'low' || p.serviceTier !== 'fast' || !threads.has(p.threadId) || p.model !== 'gpt-6.1-terra') process.exit(4);
  if(p.input[0].text.includes('No uses herramientas') || p.input[0].text.includes('No uses otras herramientas')) process.exit(5);
  const schema = p.outputSchema, workout = !!schema.properties.options?.items?.properties?.activities;
  if(schema.required.includes('description') && JSON.stringify(schema.properties.options.anyOf)!==JSON.stringify([{maxItems:0},{minItems:3,maxItems:5}]))process.exit(6);
  const result = workout ? {options:[1,2,3].map(i=>({name:'Moderado '+i,details:'Supuesto',activities:[{name:'Caminar',minutes:30,met:4}]}))} : schema.required.includes('description')
   ? { description: 'Comida', options: [1,2,3].map(i=>({ name: 'Huevos '+i, portion: 'Dos unidades', calories: 142, protein: 12, fat: 10, carbs: 1, details: 'Estimación' })) }
   : { options: [{ index: 0, protein: 12, fat: 10, carbs: 1 }] };
  emit({id:msg.id,result:{turn:{id:'turn-'+seq}}});
  emit({method:'item/completed',params:{threadId:p.threadId,item:{id:'answer',type:'agentMessage',text:JSON.stringify(result)}}});
  emit({method:'thread/tokenUsage/updated',params:{threadId:p.threadId,tokenUsage:{total:{inputTokens:1000,outputTokens:200,cachedInputTokens:800,reasoningOutputTokens:50}}}});
  emit({method:'turn/completed',params:{threadId:p.threadId,turn:{status:'completed'}}});
 }
 if (msg.method === 'thread/unsubscribe') {threads.delete(p.threadId); emit({id:msg.id,result:{status:'unsubscribed'}});}
});
`, { mode: 0o700 });
    await writeFile(join(dir, 'auth.json'), '{}');
    process.env.CODEX_HOME = dir;
    process.env.CODEX_BIN = cli;
    await codexServer.start();
    const records=[];
    await withTokenTracking({record:r=>records.push(structuredClone(r))},async()=>{
    assert.equal((await analyzePhoto(join(dir, 'photo.jpg'))).options[0].calories, 142);
    assert.equal((await analyzePhoto(join(dir, 'photo.jpg'), 'Dos huevos, sin aceite')).options.length, 3);
    assert.equal((await analyzeDescription('Dos huevos')).options[0].calories, 142);
    assert.equal((await analyzeWorkout('Caminé 30 minutos')).options[0].activities[0].minutes,30);
    assert.equal((await analyzeDescription('Dos huevos', 'Sin aceite')).options.length, 3);
    assert.equal((await estimateMissingMacros(join(dir, 'photo.jpg'), [{ index: 0, calories: 142 }], '') )[0].protein, 12);
    });
    const final=records.filter(r=>r.status==='completed');assert.equal(final.length,6);
    assert.ok(final.every(r=>r.usage?.total===1200 && r.usage.cached===800));
    assert.equal(final.filter(r=>r.source==='workout').length,1);
    assert.equal(final.filter(r=>r.source==='photo').length,3);
    assert.equal(final.filter(r=>r.source==='food').length,2);
    assert.ok(final.every(r=>r.speed==='fast' && r.model==='gpt-6.1-terra'));
    assert.equal((await readFile(join(dir, 'starts'), 'utf8')).trim(), 'started');
  } finally {
    await codexServer.stop();
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
    if (original === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = original;
    await rm(dir, { recursive: true, force: true });
  }
});

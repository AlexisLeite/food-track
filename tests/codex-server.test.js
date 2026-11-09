import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexServer } from '../server/codex-server.js';

async function fixture(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-server-test-'));
  const oldBin = process.env.CODEX_BIN, oldHome = process.env.CODEX_HOME;
  const server = new CodexServer();
  try {
    const bin = join(dir, 'codex');
    await writeFile(join(dir, 'auth.json'), '{}');
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const emit = data => console.log(JSON.stringify(data)), threads = new Map();
const trace = data => fs.appendFileSync(${JSON.stringify(join(dir, 'trace'))}, JSON.stringify(data)+'\\n');
let seq = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const msg=JSON.parse(line), p=msg.params;
 trace({pid:process.pid, ...msg});
 if(!msg.id) return;
 if(msg.method==='initialize') emit({id:msg.id,result:{}});
 if(msg.method==='thread/start') {
  const id='thread-'+(++seq); threads.set(id,p);
  emit({id:msg.id,result:{thread:{id}}});
 }
 if(msg.method==='turn/start') {
  const threadId=p.threadId, turnId='turn-'+threadId;
  emit({id:msg.id,result:{turn:{id:turnId}}});
  if(p.input[0].text==='hang')return;
  setTimeout(()=>{
   if(!threads.has(threadId))return;
   emit({method:'item/agentMessage/delta',params:{threadId,itemId:'answer',delta:p.input[0].text}});
   emit({method:'thread/tokenUsage/updated',params:{threadId,tokenUsage:{total:{inputTokens:seq,outputTokens:10}}}});
   emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  },80);
 }
 if(msg.method==='turn/interrupt') emit({id:msg.id,result:{}});
 if(msg.method==='thread/unsubscribe') {threads.delete(p.threadId); emit({id:msg.id,result:{status:'unsubscribed'}});}
});
`, { mode: 0o700 });
    process.env.CODEX_BIN = bin; process.env.CODEX_HOME = dir;
    const trace = async () => (await readFile(join(dir, 'trace'), 'utf8')).trim().split('\n').map(JSON.parse);
    await callback(server, trace);
  } finally {
    await server.stop();
    if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin;
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}
const options = prompt => ({ prompt, model: 'gpt-6.1-terra', fast: true, instructions: 'Minimal instructions.' });

test('six simultaneous requests use one process and independent threads, text, images and accounting', () => fixture(async (server, trace) => {
  const chunks = Array.from({ length: 6 }, () => []), usage = Array.from({ length: 6 }, () => []);
  const results = await Promise.all(chunks.map((chunk, i) => server.run({
    ...options(`user-${i}`), ...(i < 3 ? {imagePath:`/private/user-${i}.jpg`} : {model:'gpt-6-luna',fast:false,webSearch:true}),
    onText: text => chunk.push(text), onUsage: value => usage[i].push(value)
  })));
  assert.deepEqual(results, chunks.map((_, i) => `user-${i}`));
  assert.ok(chunks.every((chunk, i) => chunk.length === 1 && chunk[0] === `user-${i}`));
  assert.ok(usage.every(values => values.length === 1 && values[0].outputTokens === 10));
  const events = await trace(), starts = events.filter(event => event.method === 'thread/start');
  assert.equal(new Set(events.map(event => event.pid)).size, 1);
  assert.equal(events.filter(event => event.method === 'initialize').length, 1);
  assert.equal(new Set(events.filter(event => event.method === 'turn/start').map(event => event.params.threadId)).size, 6);
  assert.equal(events.filter(event => event.method === 'thread/unsubscribe').length, 6);
  assert.equal(starts.filter(event => event.params.serviceTier === 'fast' && event.params.config.web_search === 'disabled').length, 3);
  assert.equal(starts.filter(event => event.params.serviceTier === 'default' && event.params.config.web_search === 'live').length, 3);
  assert.equal(events.filter(event => event.method === 'turn/start' && event.params.input.some(input => input.type === 'localImage')).length, 3);
}));

test('cancellation and timeout interrupt only their own turn and keep the process usable', () => fixture(async (server, trace) => {
  const controller = new AbortController();
  const canceled = server.run({ ...options('hang'), signal: controller.signal, log: phase => { if (phase === 'turn_started') controller.abort(); } });
  const healthy = server.run(options('other user'));
  await assert.rejects(canceled, /cancelada/);
  assert.equal(await healthy, 'other user');
  await assert.rejects(server.run({ ...options('hang'), timeoutMs: 100 }), { code: 'CODEX_TIMEOUT' });
  assert.equal(await server.run(options('still alive')), 'still alive');
  const events = await trace();
  assert.equal(new Set(events.map(event => event.pid)).size, 1);
  assert.equal(events.filter(event => event.method === 'turn/interrupt').length, 2);
}));

test('process crash fails in-flight jobs and automatically warms a replacement for queue retries', () => fixture(async (server, trace) => {
  await server.start();
  const firstPid = server.connection.child.pid;
  const running = server.run({ ...options('hang'), log: phase => { if (phase === 'turn_started') process.kill(firstPid, 'SIGKILL'); } });
  await assert.rejects(running, { code: 'CODEX_EXIT_FAILED' });
  for (let attempt = 0; attempt < 100 && (!server.connection?.initialized || server.connection.child.pid === firstPid); attempt++) await delay(25);
  assert.ok(server.connection?.initialized);
  assert.notEqual(server.connection.child.pid, firstPid);
  assert.equal(await server.run(options('retry')), 'retry');
  assert.equal(new Set((await trace()).map(event => event.pid)).size, 2);
}));

test('an already aborted request sends no turn and leaves the shared server available', () => fixture(async server => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(server.run({ ...options('never send'), signal: controller.signal }), /cancelada/);
  assert.equal(await server.run(options('okay')), 'okay');
}));

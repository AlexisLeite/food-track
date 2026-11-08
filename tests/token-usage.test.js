import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server/app.js';
import { normalizeTokenUsage, startTokenExecution } from '../server/token-usage.js';
import { today } from '../server/nutrition.js';
import { dateOffset } from '../server/history.js';

test('token totals include cached input and reasoning exactly once, and reject missing/invalid usage',()=>{
 assert.deepEqual(normalizeTokenUsage({input_tokens:1000,output_tokens:200,cached_input_tokens:800,reasoning_output_tokens:100}),{input:1000,output:200,cached:800,reasoning:100,total:1200});
 assert.deepEqual(normalizeTokenUsage({inputTokens:1000,outputTokens:200,cachedInputTokens:800,reasoningOutputTokens:100}),{input:1000,output:200,cached:800,reasoning:100,total:1200});
 for(const bad of [null,{}, {input_tokens:1}, {input_tokens:-1,output_tokens:2},{input_tokens:10,output_tokens:2,cached_input_tokens:11},{input_tokens:10,output_tokens:2,reasoning_output_tokens:3},{input_tokens:'10',output_tokens:2}])assert.equal(normalizeTokenUsage(bad),null);
});

test('statistics are Alexis-only; isolate concurrent usage, deduplicate snapshots/replays, rank the period and survive restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'foodtrack-token-stats-'));let application,server;
 const runner=async({messages,onText})=>{
  const tokens=startTokenExecution('chat'), value=Number(messages[0].content);
  try{
   if(!Number.isFinite(value))throw new Error('Sin conteo');
   tokens.report({inputTokens:value,outputTokens:50,cachedInputTokens:0,reasoningOutputTokens:10});
   await new Promise(r=>setTimeout(r,10));
   tokens.report({inputTokens:value+100,outputTokens:200,cachedInputTokens:100,reasoningOutputTokens:50});
   tokens.report({inputTokens:value+100,outputTokens:200,cachedInputTokens:100,reasoningOutputTokens:50});
   tokens.finish('completed');onText('Respuesta');return 'Respuesta';
  }catch(error){tokens.finish('failed');throw error;}
 };
 const start=async()=>{application=await createApplication({dataDir:dir,assistantRunner:runner});server=application.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));};
 const req=async(path,{cookie,body,hash}={})=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body?'POST':'GET',headers:{'X-Foodtrack':'1',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...(hash?{'X-Submission-ID':hash}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,cache:response.headers.get('Cache-Control'),cookie:response.headers.get('set-cookie')?.split(';')[0],data:response.headers.get('content-type')?.includes('event-stream')?await response.text():await response.json()};
 };
 try{
  await start();const users=[];
  for(const username of ['Alexis','aline','daniel','another']){
   const r=await req('/api/register',{body:{username,password:'test-statistics-password'}});users.push({id:r.data.user.id,cookie:r.cookie});
   assert.equal(r.data.user.canViewStatistics,username==='Alexis');
   application.db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(r.data.user.id);
  }
  assert.equal((await req('/api/statistics')).status,401);
  assert.equal((await req('/api/statistics?username=alexis&canViewStatistics=true',{cookie:users[1].cookie})).status,403);
  assert.equal((await req('/api/statistics?days=8',{cookie:users[0].cookie})).status,400);
  const empty=await req('/api/statistics',{cookie:users[0].cookie});assert.equal(empty.cache,'no-store');assert.equal(empty.data.totals.total,0);assert.equal(empty.data.totals.unreported,0);
  for(const offset of [0,2]) await Promise.all(users.slice(offset,offset+2).map((user,i)=>{const index=offset+i;return req('/api/chat',{cookie:user.cookie,body:{messages:[{role:'user',content:String((index+1)*1000)}]},hash:String(index+1).repeat(64)});}));
  const stats=(await req('/api/statistics',{cookie:users[0].cookie})).data;
  assert.equal(stats.totals.total,11200);assert.equal(stats.totals.input,10400);assert.equal(stats.totals.output,800);assert.equal(stats.totals.cached,400);assert.equal(stats.totals.reasoning,200);assert.equal(stats.totals.executions,4);
  assert.deepEqual(stats.topUsers.map(u=>u.username),['another','daniel','aline']);assert.equal(stats.daily.at(-1).date,today());
  await req('/api/chat',{cookie:users[0].cookie,body:{messages:[{role:'user',content:'1000'}]},hash:'1'.repeat(64)});
  assert.equal(application.db.prepare('SELECT COUNT(*) n FROM token_usage').get().n,4);
  await req('/api/chat',{cookie:users[0].cookie,body:{messages:[{role:'user',content:'missing'}]}});
  const unknown=(await req('/api/statistics',{cookie:users[0].cookie})).data;assert.equal(unknown.totals.unreported,1);assert.equal(unknown.totals.total,11200);
  const earlier=dateOffset(today(),-8);
  application.db.prepare('UPDATE token_usage SET date=? WHERE user_id=?').run(earlier,users[3].id);
  application.db.prepare('UPDATE token_usage_meta SET started_at=?').run(`${earlier}T12:00:00.000Z`);
  const week=(await req('/api/statistics?days=7',{cookie:users[0].cookie})).data;assert.equal(week.totals.total,6900);assert.equal(week.daily.length,7);assert.deepEqual(week.topUsers.map(u=>u.username),['daniel','aline','alexis']);
  await new Promise(r=>server.close(r));application.db.close();await start();
  assert.equal((await req('/api/statistics?days=30',{cookie:users[0].cookie})).data.totals.total,11200);
 }finally{if(server?.listening)await new Promise(r=>server.close(r));application?.db.close();await rm(dir,{recursive:true,force:true});}
});

test('weekly estimates weight cached input, output and speed; migration preserves counts and ranking follows quota cost',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {installTokenUsage,tokenStatistics,withTokenTracking}=await import('../server/token-usage.js');
 const {weeklyQuotaPercent}=await import('../server/usage-config.js');
 assert.equal(weeklyQuotaPercent({input:300_000_000,cached:0,output:0}),100);
 assert.equal(weeklyQuotaPercent({input:6_000_000_000,cached:6_000_000_000,output:0}),100);
 assert.equal(weeklyQuotaPercent({input:0,cached:0,output:60_000_000}),100);
 assert.equal(weeklyQuotaPercent({input:300_000_000,cached:0,output:0},'fast'),250);
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT);
  INSERT INTO users VALUES('a','alexis'),('b','cached'),('c','output'),('d','standard');
  CREATE TABLE token_usage(id TEXT PRIMARY KEY,user_id TEXT,date TEXT,source TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,created_at TEXT);`);
  const old={id:'old',date:today(),created_at:new Date().toISOString()};
  db.prepare('INSERT INTO token_usage VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(old.id,'a',old.date,'food','completed',300000,0,0,0,300000,old.created_at);
  const store=installTokenUsage(db);
  assert.deepEqual({...db.prepare('SELECT id,date,input_tokens,total_tokens,created_at,speed FROM token_usage WHERE id=?').get(old.id)},{...old,input_tokens:300000,total_tokens:300000,speed:'fast'});
  for(const [id,usage]of [['b',{input_tokens:6000000,cached_input_tokens:6000000,output_tokens:0}],['c',{input_tokens:0,output_tokens:600000,reasoning_output_tokens:400000}],['d',{input_tokens:300000,output_tokens:0}]]){
   withTokenTracking(store(id),()=>{const t=startTokenExecution('chat');t.report(usage);t.report(usage);t.finish('completed');});
  }
  const stats=tokenStatistics(db,7);
  assert.ok(Math.abs(stats.totals.weeklyPercent-1.45)<1e-10);
  assert.equal(stats.daily.at(-1).weeklyPercent,stats.totals.weeklyPercent);
  assert.deepEqual(stats.topUsers.map(u=>u.username),['output','alexis','cached']);
  assert.equal(stats.quota.estimated,true);assert.equal(stats.quota.windowDays,7);
  installTokenUsage(db);assert.equal(db.prepare("SELECT speed FROM token_usage WHERE user_id='d'").get().speed,'standard');
 }finally{db.close();}
});

test('mixed model statistics preserve raw tokens and apply model and speed weights together',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {installTokenUsage,tokenStatistics,withTokenTracking}=await import('../server/token-usage.js');
 const {weeklyQuotaPercent}=await import('../server/usage-config.js');
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT); INSERT INTO users VALUES('sol','sol'),('terra','terra'),('luna','luna')");
  const store=installTokenUsage(db),usage={input_tokens:3_000_000,cached_input_tokens:1_500_000,output_tokens:600_000};
  const usageNormalized=normalizeTokenUsage(usage);
  const runs=[['sol','gpt-6.1-sol','standard'],['terra','gpt-6.1-terra','fast'],['luna','gpt-6-luna','standard']];
  for(const [id,model,speed]of runs){
   withTokenTracking(store(id),()=>{const t=startTokenExecution('food',speed,model);t.report(usage);t.finish('completed');});
   const saved=db.prepare('SELECT model,speed,input_tokens,cached_tokens,output_tokens FROM token_usage WHERE user_id=?').get(id);
   assert.deepEqual({...saved},{model,speed,input_tokens:usage.input_tokens,cached_tokens:usage.cached_input_tokens,output_tokens:usage.output_tokens});
  }
  const stats=tokenStatistics(db,7);
  const expected=runs.reduce((n,[,model,speed])=>n+weeklyQuotaPercent(usageNormalized,speed,model),0);
  assert.ok(Math.abs(stats.totals.weeklyPercent-expected)<1e-10);
  assert.deepEqual(stats.topUsers.map(u=>u.username),['terra','sol','luna']);
  assert.equal(stats.totals.total,10_800_000);
  assert.equal(weeklyQuotaPercent(usageNormalized,'fast','gpt-6.1-terra'),weeklyQuotaPercent(usageNormalized)*1.25);
  installTokenUsage(db);
  assert.equal(db.prepare("SELECT model FROM token_usage WHERE user_id='terra'").get().model,'gpt-6.1-terra');
 }finally{db.close();}
});

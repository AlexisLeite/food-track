import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { createApplication } from '../server/app.js';
import { openDatabase, postgresParameters } from '../server/database.js';
import { migrateSqlite, snapshotSqlite, tables } from '../scripts/migrate-sqlite-to-postgres.mjs';
import { createApplication as legacyApplication } from './helpers/application.js';
import { startTokenExecution } from '../server/token-usage.js';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
async function isolatedDatabase() {
  assert.ok(new URL(url).pathname.endsWith('_test'), 'Integration tests require a dedicated *_test database');
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({ connectionString: url });
  const connection = await pool.connect();
  try {
    await connection.query(`CREATE SCHEMA "${schema}"`);
    await connection.query(`SET search_path TO "${schema}"`);
    await connection.query(await readFile(new URL('../prisma/migrations/20261109213000_postgresql/migration.sql',import.meta.url),'utf8'));
  } finally { connection.release(); }
  const scoped = new URL(url); scoped.searchParams.set('schema',schema);
  return { url:scoped.toString(), async dispose() { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); } };
}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check) { for(let n=0;n<300;n++) { if(await check())return; await pause(10); } throw new Error('Timed out'); }

test('PostgreSQL placeholders preserve literal question marks',()=>{
  assert.equal(postgresParameters("SELECT '?' AS literal, ? AS value, 'it''s?' AS escaped"),"SELECT '?' AS literal, $1 AS value, 'it''s?' AS escaped");
});

test('PostgreSQL/Prisma preserves full SQLite snapshots, historical views and ordering; refuses overwrite atomically', {skip:!url}, async()=>{
  const target=await isolatedDatabase(), dir=await mkdtemp(join(tmpdir(),'foodtrack-import-test-'));
  let legacy, db;
  try {
    legacy=await legacyApplication({dataDir:dir});
    const source=legacy.db;
    source.prepare('INSERT INTO users(id,username,password,enable_codex_extraction) VALUES(?,?,?,1)').run('u','legacy-user','unchanged-hash');
    source.prepare('INSERT INTO sessions VALUES(?,?,?)').run('opaque-session-hash','u',Date.now()+1000000);
    const profile=JSON.stringify({weight:86,activity:'light',dailyCalories:2000});
    source.prepare('INSERT INTO profile_goals VALUES(?,?,?)').run('u','2026-10-01',profile);
    source.prepare('INSERT INTO profile_versions(user_id,date,profile,created_at) VALUES(?,?,?,?)').run('u','2026-11-09',JSON.stringify({weight:85,activity:'sedentary'}),'original-time');
    source.prepare('INSERT INTO meals VALUES(?,?,?,?,?,?)').run('m','u','2026-11-09','original.jpg',JSON.stringify({calories:300}), 'original-time');
    for(const id of ['z-first','a-second'])source.prepare('INSERT INTO analyses VALUES(?,?,?,?,?,?)').run(id,'m','correction','description','[]','same-time');
    source.prepare('INSERT INTO usage_reservations VALUES(?,?,?,?,?)').run('u','food','2026-11-09','meal:m','original-time');
    source.prepare("INSERT INTO extraction_jobs(id,user_id,kind,resource_id,payload,request_key,fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)").run('job','u','food','m','{}','hash','fingerprint','original-time');
    await legacy.extractionQueue.stop();
    const snapshot=await snapshotSqlite(join(dir,'foodtrack.sqlite'),join(dir,'snapshot.sqlite'));
    const report=await migrateSqlite({source:snapshot,databaseUrl:target.url});
    assert.equal(report.verified,true);assert.equal(Object.keys(report.tables).length,tables.length);assert.equal(report.tables.analyses.rows,2);
    assert.equal((await migrateSqlite({source:snapshot,databaseUrl:target.url,verifyOnly:true})).verified,true);
    await assert.rejects(migrateSqlite({source:snapshot,databaseUrl:target.url}),/not empty/);
    db=await openDatabase(target.url);
    assert.deepEqual((await db.prepare('SELECT id FROM analyses ORDER BY ordinal').all()).map(r=>r.id),['z-first','a-second']);
    assert.equal((await db.prepare('SELECT expires FROM sessions').get()).expires>2**31,true);
    const v=await db.prepare('INSERT INTO profile_versions(user_id,date,profile,created_at) VALUES(?,?,?,?)').run('u','2026-11-10','{}','new-time');
    assert.equal(v.lastInsertRowid,2);
    assert.equal((await db.prepare('SELECT enable_codex_extraction FROM users').get()).enable_codex_extraction,1);
  } finally {await legacy?.db.close();await db?.close();await target.dispose();await rm(dir,{recursive:true,force:true});}
});

test('PostgreSQL app: login, profiles, parallel quotas, durable/retried jobs, replay, ownership, workouts, chat, statistics and restart', {skip:!url}, async()=>{
  const target=await isolatedDatabase(),dir=await mkdtemp(join(tmpdir(),'foodtrack-postgres-api-'));
  let application,server;
  const counters=new Map(); let active=0,peak=0;
  const analyzer=async description=>{
    const tokens=startTokenExecution('food','fast','gpt-6.1-terra');
    active++;peak=Math.max(peak,active);
    try {
      await pause(250);
      const n=(counters.get(description)||0)+1;counters.set(description,n);
      if(description==='retry'&&n===1)throw Object.assign(new Error('Temporary error'),{status:503});
      tokens.report({input_tokens:100,output_tokens:20});await tokens.finish('completed');
      return {description,options:[{name:description,portion:'one',calories:300,protein:20,fat:10,carbs:30,details:''}]};
    } finally {active--;}
  };
  const config={dataDir:dir,databaseUrl:target.url,descriptionAnalyzer:analyzer,workoutAnalyzer:async()=>({options:[1,2,3].map(n=>({name:`op${n}`,details:'test',activities:[{name:'walk',minutes:10*n,met:3}]}))}),assistantRunner:async({onText})=>{const t=startTokenExecution('chat');t.report({input_tokens:100,output_tokens:20});await t.finish('completed');onText('Hola');return 'Hola';}};
  const boot=async()=>{application=await createApplication(config);server=application.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));};
  const stop=async()=>{await application.extractionQueue.stop();await new Promise(r=>server.close(r));await application.db.close();};
  const request=async(path,{method='GET',body,cookie,key}={})=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'X-Foodtrack':'1',...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(key?{'X-Submission-ID':key,Prefer:'respond-async'}:{})},body:body?JSON.stringify(body):undefined});
    const data=r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text();
    return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const key=()=>randomBytes(32).toString('hex');
  const day='2026-11-09';
  try {
    await boot();
    const a=await request('/api/register',{method:'POST',body:{username:'alexis',password:'test-password-123'}}),b=await request('/api/register',{method:'POST',body:{username:'another',password:'test-password-123'}});
    assert.equal(a.status,201);assert.equal(a.data.user.canChat,false);
    assert.equal((await request('/api/login',{method:'POST',body:{username:'alexis',password:'incorrect'}})).status,401);
    assert.equal((await request('/api/login',{method:'POST',body:{username:'alexis',password:'test-password-123'}})).status,200);
    assert.equal((await request('/api/register',{method:'POST',body:{username:'alexis',password:'test-password-123'}})).status,409);
    const cookie=a.cookie,id=a.data.user.id;
    const profile={height:180,age:35,weight:85,targetWeight:80,gender:'male',activity:'light',targetDate:'2027-06-01',expenditureMode:'workouts',dailyActivity:'sedentary',maxDailyDeficitPercent:10};
    assert.equal((await request('/api/profile',{method:'PUT',body:profile,cookie})).status,200);
    await application.db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(id);
    const jobs=[];
    for(let n=0;n<4;n++){
      const submission=key(),meal=await request('/api/meals/describe',{method:'POST',body:{date:day,description:n===3?'retry':`meal ${n}`},cookie,key:submission});
      assert.equal(meal.status,201,JSON.stringify(meal));
      const replay=await request('/api/meals/describe',{method:'POST',body:{date:day,description:n===3?'retry':`meal ${n}`},cookie,key:submission});
      assert.deepEqual(replay.data,meal.data);
      const extraction=key(),path=`/api/meals/${meal.data.meal.id}/analyze`;
      const job=await request(path,{method:'POST',body:{},cookie,key:extraction});assert.equal(job.status,202,JSON.stringify(job));
      jobs.push({id:job.data.job.id,mealId:meal.data.meal.id,path,key:extraction});
    }
    await until(async()=> (await application.db.prepare("SELECT COUNT(*) AS n FROM extraction_jobs WHERE state='completed'").get()).n===4);
    assert.equal(peak,3);assert.equal((await application.db.prepare('SELECT COUNT(*) AS n FROM analyses').get()).n,4);
    assert.equal((await application.db.prepare('SELECT attempts FROM extraction_jobs WHERE id=?').get(jobs[3].id)).attempts,2);
    const result=await request('/api/extractions/'+jobs[0].id,{cookie});assert.equal(result.status,200);
    assert.equal((await request('/api/extractions/'+jobs[0].id,{cookie:b.cookie})).status,404);
    const analysis=result.data.result.meal.analyses[0];
    assert.equal((await request(`/api/meals/${jobs[0].mealId}/selection`,{method:'PUT',body:{analysisId:analysis.id,optionIndex:0},cookie})).status,200);
    assert.equal((await request(`/api/meals/${jobs[0].mealId}/repeat`,{method:'POST',body:{date:'2026-11-10'},cookie})).status,201);
    const exercise=await request('/api/workouts',{method:'POST',body:{date:day,description:'walk'},cookie,key:key()});assert.equal(exercise.status,202,JSON.stringify(exercise));
    await until(async()=> (await application.db.prepare('SELECT COUNT(*) AS n FROM workouts').get()).n===1);
    const workout=(await request('/api/workouts?date='+day,{cookie})).data.workouts[0];
    assert.equal((await request(`/api/workouts/${workout.id}/confirm`,{method:'PUT',body:{optionIndex:0},cookie})).status,200);
    const correction=await request(`/api/workouts/${workout.id}/analyze`,{method:'POST',body:{instructions:'longer'},cookie,key:key()});assert.equal(correction.status,202);
    await until(async()=> (await application.db.prepare('SELECT COUNT(*) AS n FROM workout_clarifications').get()).n===1);
    for(const path of ['/api/day?date='+day,'/api/history?days=30','/api/usage','/api/statistics?days=7','/api/statistics?days=7&username=alexis'])assert.equal((await request(path,{cookie})).status,200,path);
    const chat=await request('/api/chat',{method:'POST',body:{messages:[{role:'user',content:'Hola'}]},cookie,key:key()});assert.equal(chat.status,200);assert.ok(chat.data.includes('Hola'));
    const quota=await import('../server/usage-limits.js').then(m=>m.installUsageLimits(application.db));
    const pending=Array.from({length:60},(_,n)=>quota.take(id,'food','parallel:'+n));
    const attempts=await Promise.allSettled(pending);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,52);assert.equal((await quota.snapshot(id)).budgets.food.remaining,0);
    const count=(await application.db.prepare('SELECT COUNT(*) AS n FROM meals').get()).n;
    await stop();await boot();
    const replay=await request(jobs[0].path,{method:'POST',body:{},cookie,key:jobs[0].key});assert.equal(replay.status,202);
    assert.equal((await application.db.prepare('SELECT COUNT(*) AS n FROM meals').get()).n,count);
    assert.equal((await request('/api/me',{cookie})).status,200,'Session survives PostgreSQL restart');
    assert.equal((await request('/api/password',{method:'PUT',body:{currentPassword:'test-password-123',newPassword:'new-password-123',confirmPassword:'new-password-123'},cookie})).status,200);
    assert.equal((await request('/api/login',{method:'POST',body:{username:'alexis',password:'new-password-123'}})).status,200);
    assert.equal((await request('/api/me',{cookie:b.cookie})).status,200);
  } finally {if(server?.listening)await stop();await target.dispose();await rm(dir,{recursive:true,force:true});}
});

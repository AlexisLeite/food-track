import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createExtractionQueue } from '../server/extraction-queue.js';
import { installUsageLimits, usagePeriod } from '../server/usage-limits.js';
import { createSemaphore } from '../server/semaphore.js';
import { pollExtraction } from '../public/extractions.js';
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { for (let n=0;n<400;n++) { if (check()) return; await pause(); } throw new Error('Timed out'); }
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,enable_codex_extraction INTEGER); INSERT INTO users VALUES('a',1),('b',1);
    CREATE TABLE meals(id TEXT,user_id TEXT,created_at TEXT); CREATE TABLE analyses(id TEXT,meal_id TEXT,created_at TEXT); CREATE TABLE token_usage(id TEXT,user_id TEXT,created_at TEXT,source TEXT);`);
  return db;
}

test('three extractions run concurrently, the fourth waits, retries preserve jobs and reservations', async () => {
  const db=fixture(), limits=installUsageLimits(db); let active=0,peak=0,attempts=0; const releases=[];
  const queue=createExtractionQueue(db,{retryDelays:[1,1]});
  queue.register('food',async job=>{active++;peak=Math.max(peak,active);attempts++;try {await new Promise(r=>releases.push(r));if(job.payload.fail && job.attempts<3)throw Object.assign(new Error('Unavailable'),{status:503});return {owner:job.user_id};}finally{active--;}});
  const add=(key,fail=false)=>queue.enqueue({userId:'a',kind:'food',resourceId:key,payload:{fail},key,reserve:id=>limits.take('a','food',id)});
  queue.start(); const ids=['one','two','three','four'].map(key=>add(key,key==='four'));
  await until(()=>releases.length===3); assert.equal(active,3);assert.equal(queue.read(ids[3],'a').job.state,'queued');
  assert.throws(()=>queue.read(ids[0],'b'),{status:404});
  assert.equal(add('one'),ids[0]); assert.throws(()=>add('one',true),{status:409});
  releases.splice(0).forEach(r=>r());
  for(let i=0;i<3;i++){await until(()=>releases.length>0);releases.shift()();}
  await until(()=>queue.read(ids[3],'a').job.state==='completed');
  assert.equal(peak,3);assert.equal(attempts,6);assert.equal(queue.read(ids[3],'a').job.attempts,3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_reservations').get().n,4);
  await queue.stop();db.close();
});

test('persisted jobs resume after restart; permissions are checked at execution, not only submission', async()=>{
  const db=fixture();const queue=createExtractionQueue(db);
  const first=queue.enqueue({userId:'a',kind:'food',resourceId:'one',payload:{},key:'first'});
  const denied=queue.enqueue({userId:'b',kind:'food',resourceId:'two',payload:{},key:'denied'});
  db.prepare("UPDATE extraction_jobs SET state='running' WHERE id=?").run(first);
  await queue.stop();db.exec("UPDATE users SET enable_codex_extraction=0 WHERE id='b'");
  let calls=0; const recovered=createExtractionQueue(db); recovered.register('food',async()=>{calls++;return {ok:true};});recovered.start();
  await until(()=>recovered.read(first,'a').job.state==='completed');
  await until(()=>db.prepare('SELECT state FROM extraction_jobs WHERE id=?').get(denied).state==='failed');
  assert.equal(calls,1);assert.equal(db.prepare('SELECT attempts FROM extraction_jobs WHERE id=?').get(denied).attempts,1);
  assert.throws(()=>recovered.read(denied,'b'),{status:403});await recovered.stop();db.close();
});

test('weekly quotas are shared for corrections, independent by kind/user, atomic and reset Monday Uruguay',()=>{
  const db=fixture();let date='2026-11-08';const limits=installUsageLimits(db,()=>date);
  assert.equal(usagePeriod('food',date),'2026-11-02');assert.equal(usagePeriod('food','2026-11-09'),'2026-11-09');
  for(let n=0;n<56;n++){limits.take('a','food',`f${n}`);limits.take('a','workout',`w${n}`);}
  for(let n=0;n<168;n++)limits.take('a','clarification',`${n%2?'workout':'food'}:${n}`);
  for(const kind of ['food','workout','clarification'])assert.throws(()=>limits.take('a',kind,'excess'),{status:429});
  limits.take('a','food','f0');limits.take('b','food','another');
  for(let n=0;n<5;n++)limits.take('a','chat',`c${n}`);assert.throws(()=>limits.take('a','chat','excess'),{status:429});
  date='2026-11-09';for(const kind of ['food','workout','clarification','chat'])limits.take('a',kind,'new');
  date='2026-11-10';limits.take('a','chat','tomorrow');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE user_id='a' AND kind='food'").get().n,57);
  db.exec('BEGIN IMMEDIATE');limits.take('b','food','rolled-back');db.exec('ROLLBACK');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE request_key='rolled-back'").get().n,0);db.close();
});

test('chat has its own three slots and waiting requests can be cancelled without leaking capacity',async()=>{
  const queue=createSemaphore(3), releases=await Promise.all([queue.acquire(),queue.acquire(),queue.acquire()]);
  let started=false;const pending=queue.acquire().then(release=>{started=true;return release;});
  const abort=new AbortController();const cancelled=queue.acquire(abort.signal);abort.abort();await assert.rejects(cancelled,/cancelada/);
  await pause();assert.equal(started,false);releases[0]();const release=await pending;assert.equal(started,true);
  release();release();releases.slice(1).forEach(r=>r()); const again=await queue.acquire();again();
});

test('client polls durable jobs, tolerates transient network failure, rejects failed jobs and changed sessions',async()=>{
  let requests=0;const initial={job:{id:'saved',state:'queued'}};
  const result=await pollExtraction(initial,{sleep:async()=>{},request:async path=>{assert.equal(path,'/api/extractions/saved');requests++;if(requests===1)throw new Error('Offline');return requests===2?{job:{state:'running'}}:{job:{state:'completed'},result:{meal:{id:'same'}}};}});
  assert.equal(result.meal.id,'same');assert.equal(requests,3);
  await assert.rejects(pollExtraction({job:{state:'failed'},error:'Invalid',status:400},{request:()=>{}}),{status:400});
  await assert.rejects(pollExtraction(initial,{isCurrent:()=>false,request:()=>{}}),/sesión cambió/);
});

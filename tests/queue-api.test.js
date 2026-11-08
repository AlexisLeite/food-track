import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/app.js';
import { calculateProfile, today } from '../server/nutrition.js';
import { usagePeriod } from '../server/usage-limits.js';
import { startTokenExecution } from '../server/token-usage.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const food = {description:'Huevos',options:[{name:'Huevos',portion:'Dos',calories:140,protein:12,fat:10,carbs:1,details:'Sin aceite'}]};
const workout = { options: [5,10,15].map(minutes=>({name:`Bloque ${minutes}`,details:'Estimado',activities:[{name:'Dominadas',minutes,met:4}]})) };
const wait = async check => {for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timeout');};

test('async API queues, replays after restart, attributes tokens, enforces sent-date budgets and shares correction limits',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'foodtrack-queue-api-'));let application,server,calls=0;
  const releases=[];
  const config={dataDir:dir,descriptionAnalyzer:async()=>{calls++;await new Promise(r=>releases.push(r));const usage=startTokenExecution('food');usage.report({input_tokens:10,output_tokens:1});usage.finish('completed');return food;},workoutAnalyzer:async()=>workout};
  const boot=async()=>{application=await createApplication(config);server=application.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));};
  const request=async(path,user,body,hash,method=body?'POST':'GET')=>{
    const res=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'X-Foodtrack':'1','Content-Type':'application/json',Prefer:'respond-async',...(user?{Cookie:`foodtrack_session=${user}`} :{}),...(hash?{'X-Submission-ID':digest(hash)}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};
  };
  const stop=async()=>{await application.extractionQueue.stop();await new Promise(r=>server.close(r));application.db.close();};
  try {
    await boot();
    const profile=calculateProfile({height:175,age:30,weight:80,targetWeight:75,gender:'male',activity:'moderate',targetDate:'2027-01-01',expenditureMode:'workouts',dailyActivity:'sedentary'});
    for(const id of ['a','b']){
      application.db.prepare('INSERT INTO users(id,username,password,profile,enable_codex_extraction) VALUES(?,?,?,?,1)').run(id,`user-${id}`,'test',JSON.stringify(profile));
      application.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(id),id,Date.now()+1000000);
      application.db.prepare('INSERT INTO profile_versions(user_id,date,profile,created_at) VALUES(?,?,?,?)').run(id,today(),JSON.stringify(profile),new Date().toISOString());
    }
    assert.equal((await request('/api/usage', null)).status,401);
    const emptyBudget=await request('/api/usage','a'); assert.equal(emptyBudget.status,200); assert.equal(emptyBudget.data.budgets.food.remaining,56);
    const meals=[];
    for(let i=0;i<4;i++)meals.push((await request('/api/meals/describe',i%2?'b':'a',{date:'2020-01-01',description:'Huevos'},`create${i}`)).data.meal);
    await request('/api/meals/describe','b',{date:'2020-01-01',description:'Otra comida'},'other-budget');
    assert.equal((await request('/api/usage','b')).data.budgets.food.remaining,53);
    assert.equal((await request('/api/usage?user_id=b','a')).data.budgets.food.remaining,54);
    assert.equal((await request('/api/usage','a')).data.budgets.chat.remaining,5);
    const jobs=[];
    for(let i=0;i<4;i++)jobs.push(await request(`/api/meals/${meals[i].id}/analyze`,i%2?'b':'a',{instructions:''},`analyze${i}`));
    assert.ok(jobs.every(r=>r.status===202));await wait(()=>calls===3);assert.equal(calls,3);
    const id=jobs[0].data.job.id;
    assert.equal((await request(`/api/extractions/${id}`,'b')).status,404);
    assert.equal((await request(`/api/meals/${meals[0].id}/analyze`,'a',{instructions:''},'analyze0')).data.job.id,id);
    releases.splice(0).forEach(r=>r());await wait(()=>calls===4);releases.splice(0).forEach(r=>r());
    await wait(()=>application.db.prepare("SELECT COUNT(*) n FROM extraction_jobs WHERE state='completed'").get().n===4);
    assert.equal(application.db.prepare('SELECT COUNT(*) n FROM analyses').get().n,4);
    assert.deepEqual(application.db.prepare('SELECT user_id,COUNT(*) n FROM token_usage GROUP BY user_id ORDER BY user_id').all().map(r=>({...r})),[{user_id:'a',n:2},{user_id:'b',n:2}]);
    application.db.prepare("UPDATE extraction_jobs SET state='running',result=NULL WHERE id=?").run(id);
    await stop();await boot();
    await wait(()=>application.db.prepare('SELECT state FROM extraction_jobs WHERE id=?').get(id).state==='completed');
    const replay=await request(`/api/meals/${meals[0].id}/analyze`,'a',{instructions:''},'analyze0');assert.equal(replay.data.job.id,id);
    assert.equal((await request(`/api/extractions/${id}`,'a')).data.result.meal.id,meals[0].id);assert.equal(calls,4);
    const day=today(),week=usagePeriod('food',day);
    for(let i=0;i<54;i++)application.db.prepare('INSERT INTO usage_reservations VALUES(?,?,?,?,?)').run('a','food',week,`fill${i}`,new Date().toISOString());
    assert.equal((await request('/api/meals/describe','a',{date:'1999-01-01',description:'No bypass'},'over')).status,429);
    assert.equal((await request('/api/usage','a')).data.budgets.food.remaining,0);
    await request(`/api/meals/${meals[0].id}`,'a',null,null,'DELETE');
    assert.equal((await request('/api/meals/describe','a',{date:'2099-01-01',description:'No refund'},'over2')).status,429);
    const training=await request('/api/workouts','a',{date:day,description:'Dominadas'},'workout');assert.equal(training.status,202);
    await wait(()=>application.db.prepare('SELECT COUNT(*) n FROM workouts').get().n===1);
    const workoutId=(await request(`/api/extractions/${training.data.job.id}`,'a')).data.result.workout.id;
    for(let i=0;i<168;i++)application.db.prepare('INSERT INTO usage_reservations VALUES(?,?,?,?,?)').run('a','clarification',week,`clarification${i}`,new Date().toISOString());
    assert.equal((await request(`/api/meals/${meals[2].id}/analyze`,'a',{instructions:'Más grande'},'food-over')).status,429);
    assert.equal((await request(`/api/workouts/${workoutId}/analyze`,'a',{instructions:'Fueron 10 minutos'},'workout-over')).status,429);
    application.db.prepare("DELETE FROM usage_reservations WHERE request_key='clarification0'").run();
    const correction=await request(`/api/workouts/${workoutId}/analyze`,'a',{instructions:'Fueron 10 minutos'},'workout-correction');assert.equal(correction.status,202);
    await wait(()=>application.db.prepare('SELECT COUNT(*) n FROM workout_clarifications').get().n===1);
    assert.equal((await request(`/api/workouts/${workoutId}/analyze`,'b',{instructions:'Ajeno'},'other')).status,404);
  } finally {releases.splice(0).forEach(r=>r());if(application.db.isOpen)await stop();await rm(dir,{recursive:true,force:true});}
});

test('chat accepts three simultaneous conversations, queues the fourth and daily sixth turn is rejected',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'foodtrack-chat-queue-'));const releases=[];let active=0,peak=0;
  const application=await createApplication({dataDir:dir,assistantRunner:async()=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>releases.push(r));return 'Respuesta';}finally{active--;}}});
  const server=application.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const request=async(user,key)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/chat`,{method:'POST',headers:{'X-Foodtrack':'1','Content-Type':'application/json',Cookie:`foodtrack_session=${user}`,'X-Submission-ID':digest(key)},body:JSON.stringify({messages:[{role:'user',content:'Cómo voy'}]})});return {status:response.status,text:await response.text()};};
  try{
    for(const id of ['a','b','c','d']){application.db.prepare('INSERT INTO users(id,username,password,enable_codex_extraction) VALUES(?,?,?,1)').run(id,`chat-${id}`,'test');application.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(id),id,Date.now()+1000000);}
    const pending=['a','b','c','d'].map(id=>request(id,id));await wait(()=>active===3);assert.equal(releases.length,3);
    releases.splice(0).forEach(r=>r());await wait(()=>releases.length===1);releases.shift()();assert.ok((await Promise.all(pending)).every(r=>r.status===200));assert.equal(peak,3);
    for(let i=1;i<5;i++){const pending=request('a',`turn${i}`);await wait(()=>releases.length===1);releases.shift()();assert.equal((await pending).status,200);}
    assert.equal((await request('a','sixth')).status,429);assert.match((await request('a','a')).text,/Respuesta/);
    assert.equal(application.db.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE user_id='a' AND kind='chat'").get().n,5);
  }finally{releases.splice(0).forEach(r=>r());await application.extractionQueue.stop();await new Promise(r=>server.close(r));application.db.close();await rm(dir,{recursive:true,force:true});}
});

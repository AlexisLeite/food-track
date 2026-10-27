import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { processFoodSubmission } from '../public/outbox.js';
import { createApplication } from '../server/app.js';

const digest = text => createHash('sha256').update(text).digest('hex');
test('audio checkpoints transcription and meal creation; a retry resumes analysis with the same hash', async () => {
  const item = { id: digest('one audio'), kind: 'meal', blob: new Blob(['audio'], { type: 'audio/webm' }), date: '2026-10-26' };
  const calls = []; let fail = true;
  const dependencies = { request: async (url, options) => {
    calls.push({ url, hash: options.headers['X-Submission-ID'] });
    if (url === '/api/transcribe') return { text: 'Dos huevos' };
    if (url === '/api/meals/describe') { assert.equal(options.body.description, 'Dos huevos'); return { meal: { id: 'saved-meal' } }; }
    if (fail) throw new Error('Conexión interrumpida');
    return { meal: { id: 'saved-meal', analyses: [1] } };
  } };
  const checkpoint = async fields => Object.assign(item, structuredClone(fields));
  await assert.rejects(processFoodSubmission(item, checkpoint, () => {}, dependencies), /Conexión/);
  assert.equal(item.text, 'Dos huevos'); assert.equal(item.mealId, 'saved-meal'); assert.equal(item.blob.size, 5);
  fail = false;
  assert.equal((await processFoodSubmission(item, checkpoint, () => {}, dependencies)).meal.id, 'saved-meal');
  assert.deepEqual(calls.map(c => c.url), ['/api/transcribe', '/api/meals/describe', '/api/meals/saved-meal/analyze', '/api/meals/saved-meal/analyze']);
  assert.equal(calls[2].hash, calls[3].hash); assert.match(calls[2].hash, /^[a-f0-9]{64}$/);
});

test('photo is compressed once and remains available when upload fails; reevaluation keeps its instructions', async () => {
  const item = { id: digest('photo'), kind: 'photo', blob: new Blob(['original'], {type:'image/jpeg'}), date:'2026-10-26' };
  let prepared = 0, attempts = 0;
  const dependencies = { preparePhoto: async () => { prepared++; return new Blob(['compressed'], { type: 'image/jpeg' }); }, request: async url => {
    if (url === '/api/meals') { if (!attempts++) throw new Error('Offline'); return { meal: {id:'photo-meal'} }; }
    return { meal: { id:'photo-meal' } };
  } };
  const checkpoint = async fields => Object.assign(item, fields);
  await assert.rejects(processFoodSubmission(item, checkpoint, () => {}, dependencies), /Offline/);
  await processFoodSubmission(item, checkpoint, () => {}, dependencies);
  assert.equal(prepared, 1); assert.equal(await item.blob.text(), 'compressed');
  await processFoodSubmission({ id:digest('correction'), kind:'reevaluate', mealId:'photo-meal', text:'Sin aceite' }, checkpoint, () => {}, { request: async (url, options) => {
    assert.equal(url, '/api/meals/photo-meal/analyze'); assert.equal(options.body.instructions, 'Sin aceite'); return {};
  } });
});

test('server receipts survive restart, prevent duplicate text/photo/analysis/chat and isolate users', async () => {
  const dir = await mkdtemp(join(tmpdir(),'foodtrack-idempotency-'));
  let calls = 0, chats = 0, release;
  let gate;
  const result = { description:'Huevos', options:[{name:'Huevos',portion:'Dos',calories:140,protein:12,fat:10,carbs:1,details:'Sin aceite'}] };
  const config = { dataDir:dir, descriptionAnalyzer: async () => { calls++; if(gate)await gate; return result; }, assistantRunner:async () => {chats++;return 'Respuesta';} };
  let application = await createApplication(config), server;
  const listen = async () => { server=application.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return `http://127.0.0.1:${server.address().port}`; };
  let base=await listen();
  const request=async (path, cookie, body, key, method='POST') => {
    const response=await fetch(base+path,{method,headers:{'X-Foodtrack':'1',...(cookie?{Cookie:cookie}:{}),...(key?{'X-Submission-ID':digest(key)}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
    return { status:response.status, data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text(), cookie:response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const a=await request('/api/register',null,{username:'pending-a',password:'long-password-123'}),b=await request('/api/register',null,{username:'pending-b',password:'long-password-123'});
    for(const u of [a,b]){application.db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(u.data.user.id);await request('/api/profile',u.cookie,{height:175,age:30,weight:80,gender:'male',activity:'moderate',targetWeight:75,targetDate:'2099-01-01'},null,'PUT');}
    const body={date:'2026-10-26',description:'Dos huevos'};
    const first=await request('/api/meals/describe',a.cookie,body,'create'); assert.equal(first.status,201);assert.equal(first.data.submissionHash,digest('create'));
    const meal=first.data.meal.id;
    assert.deepEqual((await request('/api/meals/describe',a.cookie,body,'create')).data,first.data);
    assert.equal((await request('/api/meals/describe',a.cookie,{...body,description:'Otro'},'create')).status,409);
    assert.notEqual((await request('/api/meals/describe',b.cookie,body,'create')).data.meal.id,meal);
    gate=new Promise(r=>release=r);
    const inflight=request(`/api/meals/${meal}/analyze`,a.cookie,{instructions:''},'analysis');
    while(!calls)await new Promise(r=>setTimeout(r,5));
    assert.equal((await request(`/api/meals/${meal}/analyze`,a.cookie,{instructions:''},'analysis')).status,409);
    release();gate=null;const analysis=await inflight;assert.equal(analysis.status,200);
    assert.deepEqual((await request(`/api/meals/${meal}/analyze`,a.cookie,{instructions:''},'analysis')).data,analysis.data);assert.equal(calls,1);
    const photo=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).jpeg().toBuffer();
    const payload=()=>{const f=new FormData();f.append('date','2026-10-26');f.append('photo',new Blob([photo],{type:'image/jpeg'}),'food.jpg');return f;};
    const photo1=await request('/api/meals',a.cookie,payload(),'photo');const photo2=await request('/api/meals',a.cookie,payload(),'photo');
    assert.equal(photo1.status,201);assert.equal(photo2.data.meal.id,photo1.data.meal.id);
    const messages={messages:[{role:'user',content:'Cómo voy'}]};
    assert.match((await request('/api/chat',a.cookie,messages,'chat')).data,/Respuesta/);
    assert.match((await request('/api/chat',a.cookie,messages,'chat')).data,/Respuesta/);assert.equal(chats,1);
    await new Promise(r=>server.close(r));application.db.close();application=await createApplication(config);base=await listen();
    assert.deepEqual((await request('/api/meals/describe',a.cookie,body,'create')).data,first.data);
    assert.deepEqual((await request(`/api/meals/${meal}/analyze`,a.cookie,{instructions:''},'analysis')).data,analysis.data);assert.equal(calls,1);
    application.db.prepare('UPDATE users SET enable_codex_extraction=0 WHERE id=?').run(a.data.user.id);
    assert.equal((await request(`/api/meals/${meal}/analyze`,a.cookie,{instructions:''},'analysis')).status,403);
    assert.equal((await request('/api/chat',a.cookie,messages,'chat')).status,403);
    assert.equal(application.db.prepare('SELECT count(*) n FROM meals WHERE user_id=?').get(a.data.user.id).n,2);
  }finally{release?.();await new Promise(r=>server.close(r));application.db.close();await rm(dir,{recursive:true,force:true});}
});

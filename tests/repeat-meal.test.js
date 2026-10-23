import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {createApplication} from '../server/app.js';

test('repeating copies the selected snapshot and independent photo/options with owner isolation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'foodtrack-repeat-'));let calls=0;
 const analyze=async()=>{calls++;return{description:'Arroz',options:[{name:'Arroz',portion:'Un plato',calories:300,protein:6,fat:4,carbs:60,details:'Estimado'},{name:'Arroz grande',portion:'Dos platos',calories:600,protein:12,fat:8,carbs:120,details:'Estimado'}]};};
 const {app,db}=await createApplication({dataDir:dir,secureCookies:false,analyzer:analyze,descriptionAnalyzer:analyze});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,{method='GET',body,cookie,csrf=true}={}){const headers={...(csrf?{'X-Foodtrack':'1'}:{}),...(cookie?{Cookie:cookie}:{})};if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}const res=await fetch(base+path,{method,headers,body});return{status:res.status,cookie:res.headers.get('set-cookie')?.split(';')[0],body:res.headers.get('content-type')?.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer())};}
 try{
  const alice=await request('/api/register',{method:'POST',body:{username:'repeat-alice',password:'testpassword-12345'}}),bob=await request('/api/register',{method:'POST',body:{username:'repeat-bob',password:'testpassword-12345'}});const cookie=alice.cookie;db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(alice.body.user.id);
  await request('/api/profile',{method:'PUT',cookie,body:{height:175,age:30,weight:80,targetWeight:75,gender:'male',activity:'moderate',targetDate:'2099-01-01'}});
  const image=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).jpeg().toBuffer();const form=new FormData();form.append('date','2026-10-19');form.append('photo',new Blob([image],{type:'image/jpeg'}),'meal.jpg');
  const upload=await request('/api/meals',{method:'POST',cookie,body:form});const id=upload.body.meal.id,repeat=`/api/meals/${id}/repeat`;
  assert.equal((await request(repeat,{method:'POST',cookie,body:{date:'2026-10-20'}})).status,409);
  const initial=await request(`/api/meals/${id}/analyze`,{method:'POST',cookie,body:{}});const oldAnalysis=initial.body.meal.analyses[0].id;
  await request(`/api/meals/${id}/selection`,{method:'PUT',cookie,body:{analysisId:oldAnalysis,optionIndex:0}});
  await request(`/api/meals/${id}/analyze`,{method:'POST',cookie,body:{instructions:'Un plato pequeño'}});
  assert.equal((await request(repeat,{method:'POST',body:{date:'2026-10-20'}})).status,401);
  assert.equal((await request(repeat,{method:'POST',cookie:bob.cookie,body:{date:'2026-10-20'}})).status,404);
  assert.equal((await request(repeat,{method:'POST',cookie,csrf:false,body:{date:'2026-10-20'}})).status,403);
  assert.equal((await request(repeat,{method:'POST',cookie,body:{date:'2026-02-30'}})).status,400);
  const repeated=await request(repeat,{method:'POST',cookie,body:{date:'2026-10-20',calories:9999}});assert.equal(repeated.status,201);const copy=repeated.body.meal;
  assert.notEqual(copy.id,id);assert.notEqual(copy.photoUrl,upload.body.meal.photoUrl);assert.equal(copy.date,'2026-10-20');assert.equal(copy.selected.calories,300);assert.equal(copy.selected.protein,6);assert.equal(copy.analyses.length,2);assert.equal(calls,2);
  assert.notEqual(copy.selected.analysisId,oldAnalysis);assert.ok(copy.analyses.some(a=>a.id===copy.selected.analysisId));assert.ok(copy.analyses.every(a=>a.meal_id===copy.id));
  assert.equal((await request('/api/day?date=2026-10-20',{cookie})).body.total,300);
  const photo=(await request(upload.body.meal.photoUrl,{cookie})).body;assert.deepEqual((await request(copy.photoUrl,{cookie})).body,photo);
  await request(`/api/meals/${copy.id}/selection`,{method:'PUT',cookie,body:{analysisId:copy.selected.analysisId,optionIndex:1}});
  assert.equal((await request('/api/day?date=2026-10-19',{cookie})).body.total,300);assert.equal((await request('/api/day?date=2026-10-20',{cookie})).body.total,600);
  await request(`/api/meals/${id}`,{method:'DELETE',cookie});assert.deepEqual((await request(copy.photoUrl,{cookie})).body,photo);
  await request(`/api/meals/${copy.id}`,{method:'DELETE',cookie});assert.equal((await request(copy.photoUrl,{cookie})).status,404);
  const text=await request('/api/meals/describe',{method:'POST',cookie,body:{date:'2026-10-19',description:'Dos huevos'}});const textId=text.body.meal.id;
  const analyzed=await request(`/api/meals/${textId}/analyze`,{method:'POST',cookie,body:{}});await request(`/api/meals/${textId}/selection`,{method:'PUT',cookie,body:{analysisId:analyzed.body.meal.analyses[0].id,optionIndex:0}});
  const textCopy=await request(`/api/meals/${textId}/repeat`,{method:'POST',cookie,body:{date:'2026-10-19'}});assert.equal(textCopy.status,201);assert.equal(textCopy.body.meal.description,'Dos huevos');assert.equal(textCopy.body.meal.photoUrl,null);assert.equal(calls,3);
  assert.equal((await request('/api/day?date=2026-10-19',{cookie})).body.total,600);
 }finally{await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});}
});

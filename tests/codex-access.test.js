import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createApplication } from '../server/app.js';

const option = { name:'Huevos', portion:'2 unidades', calories:142, protein:12, fat:10, carbs:1, details:'Sin aceite' };
test('all accounts default to zero; only SQL enables extraction and revocation applies to existing sessions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'codex-access-'));
  let calls = 0;
  const analyze = async () => { calls++; return { description:'Huevos',options:[option] }; };
  const { app, db } = await createApplication({ dataDir, analyzer:analyze, descriptionAnalyzer:analyze });
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,{body,cookie,method='POST'}={})=>{
    const response=await fetch(base+path,{method,headers:{'X-Foodtrack':'1',...(cookie?{Cookie:cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const accounts=[];
    for(const username of ['alexis','aline6656','another-user']){
      const registered=await request('/api/register',{body:{username,password:'test-password-123',enable_codex_extraction:1}});
      assert.equal(registered.status,201);accounts.push(registered);
      assert.equal(db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(registered.body.user.id).enable_codex_extraction,0);
    }
    const {cookie,body:{user}}=accounts[0];
    const config={height:175,age:30,weight:80,targetWeight:75,gender:'male',activity:'light',targetDate:'2099-01-01',enable_codex_extraction:1};
    assert.equal((await request('/api/profile',{method:'PUT',cookie,body:config})).status,200);
    assert.equal(db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(user.id).enable_codex_extraction,0);
    const described=await request('/api/meals/describe',{cookie,body:{date:'2026-10-23',description:'Dos huevos'}});
    const id=described.body.meal.id;
    const denied=await request(`/api/meals/${id}/analyze`,{cookie,body:{enable_codex_extraction:1}});
    assert.equal(denied.status,403);
    assert.equal(denied.body.code,'CODEX_EXTRACTION_DISABLED');
    assert.match(denied.body.error,/No tenés autorización/);
    assert.match(denied.body.error,/Contactá con el administrador/);
    const image=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer();
    const form=new FormData();form.append('date','2026-10-23');form.append('photo',new Blob([image],{type:'image/png'}),'photo.png');
    const uploaded=await request('/api/meals',{cookie,body:form});assert.equal(uploaded.status,201);
    assert.equal((await request(`/api/meals/${uploaded.body.meal.id}/analyze`,{cookie,body:{instructions:'Huevos'}})).status,403);
    assert.equal(calls,0);
    db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(user.id);
    assert.equal((await request(`/api/meals/${id}/analyze`,{cookie,body:{}})).status,200);
    assert.equal((await request(`/api/meals/${uploaded.body.meal.id}/analyze`,{cookie,body:{}})).status,200);
    assert.equal(calls,2);
    const analysis=db.prepare('SELECT id FROM analyses WHERE meal_id=?').get(id);
    db.prepare('UPDATE users SET enable_codex_extraction=0 WHERE id=?').run(user.id);
    assert.equal((await request(`/api/meals/${id}/analyze`,{cookie,body:{instructions:'Sin aceite'}})).status,403);
    assert.equal(calls,2);
    // Existing options remain usable; ownership checks still apply before permission checks.
    assert.equal((await request(`/api/meals/${id}/selection`,{method:'PUT',cookie,body:{analysisId:analysis.id,optionIndex:0}})).status,200);
    assert.equal((await request(`/api/meals/${id}/analyze`,{cookie:accounts[1].cookie,body:{}})).status,404);
    assert.equal((await request(`/api/meals/${id}/analyze`,{body:{}})).status,401);
  }finally{await new Promise(r=>server.close(r));db.close();await rm(dataDir,{recursive:true,force:true});}
});

test('legacy databases are backed up and migrated with access disabled, without restoring revoked permissions on restart', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'codex-access-migration-'));
  const file=join(dataDir,'foodtrack.sqlite');const legacy=new DatabaseSync(file);
  legacy.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,profile TEXT)');
  legacy.prepare('INSERT INTO users VALUES(?,?,?,?)').run('existing','alexis','unused',null);legacy.close();
  let current;
  try{
    current=await createApplication({dataDir});
    assert.equal(current.db.prepare('SELECT enable_codex_extraction FROM users').get().enable_codex_extraction,0);
    const column=current.db.prepare('PRAGMA table_info(users)').all().find(c=>c.name==='enable_codex_extraction');assert.equal(column.dflt_value,'0');assert.equal(column.notnull,1);
    assert.ok((await readdir(join(dataDir,'backups'))).some(name=>name.startsWith('before-codex-access-')));
    current.db.prepare('UPDATE users SET enable_codex_extraction=1').run();current.db.close();current=null;
    current=await createApplication({dataDir});assert.equal(current.db.prepare('SELECT enable_codex_extraction FROM users').get().enable_codex_extraction,1);
    current.db.prepare('UPDATE users SET enable_codex_extraction=0').run();current.db.close();current=null;
    current=await createApplication({dataDir});assert.equal(current.db.prepare('SELECT enable_codex_extraction FROM users').get().enable_codex_extraction,0);
  }finally{current?.db.close();await rm(dataDir,{recursive:true,force:true});}
});

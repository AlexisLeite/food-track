import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProfileVersions, appendProfileVersion } from '../server/profile-versions.js';
import { buildHistory, buildWeek, dateOffset, weekRange } from '../server/history.js';
import { createApplication } from '../server/app.js';
import { calculateProfile, today } from '../server/nutrition.js';

const original = { weight:80,targetWeight:75,dailyCalories:2000,expenditure:2500 };
const updated = { weight:80,targetWeight:85,dailyCalories:2600,expenditure:2800 };
const goal = (date,profile) => ({date,profile:JSON.stringify(profile)});
const meal = (date,calories) => ({date,selected:JSON.stringify({calories,protein:10,fat:10,carbs:10})});

test('midweek edits preserve all earlier targets/macros/maintenance and split the remaining budget at the effective date',()=>{
 const start='2026-10-25',end='2026-10-31',asOf='2026-10-29';
 const goals=[goal(start,original)];
 const meals=[meal('2026-10-25',2100),meal('2026-10-26',1800),meal('2026-10-27',1900),meal('2026-10-28',2000)];
 const before=buildHistory({start,end,asOf,goals,meals});
 const changed=[...goals,goal(asOf,updated)];
 const after=buildHistory({start,end,asOf,goals:changed,meals});
 assert.deepEqual(after.days.slice(0,4),before.days.slice(0,4));
 const budget=buildWeek({date:asOf,asOf,goals:changed,meals,profile:updated});
 assert.equal(budget.target,4*2000+3*2600);
 assert.equal(budget.consumedBeforeDate,7800);
 assert.equal(budget.dailyCalories,Math.round((4*2000+3*2600-7800)/3));
 assert.equal(budget.maintenance,4*2500+3*2800);
 for(const day of after.days.slice(4)){
  assert.equal(day.target.calories,budget.dailyCalories);assert.equal(day.maintenance.calories,2800);
  assert.equal(day.target.protein,Math.round(budget.dailyCalories*.25/4*10)/10);
 }
 assert.equal(buildWeek({date:'2026-11-01',asOf,goals:changed,meals,profile:updated}).dailyCalories,2600);
 // Adding another future change cannot alter today's or any earlier projection.
 const future=buildHistory({start,end,asOf,goals:[...changed,goal('2026-10-30',{...updated,dailyCalories:3000})],meals});
 assert.deepEqual(future.days,after.days);
});

test('migration is additive, backed up, repeatable and retains each same-day version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'foodtrack-profile-migration-'));
 const db=new DatabaseSync(join(dir,'test.sqlite'));
 try{
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,profile TEXT); CREATE TABLE profile_goals(user_id TEXT,date TEXT,profile TEXT,PRIMARY KEY(user_id,date)); CREATE TABLE meals(id TEXT,selected TEXT);');
  db.prepare('INSERT INTO users VALUES(?,?)').run('one',JSON.stringify(updated));
  db.prepare('INSERT INTO users VALUES(?,?)').run('two',JSON.stringify({...original,startDate:'2026-10-20'}));
  db.prepare('INSERT INTO profile_goals VALUES(?,?,?)').run('one','2026-10-25',JSON.stringify(original));
  db.prepare('INSERT INTO profile_goals VALUES(?,?,?)').run('one','2026-10-29',JSON.stringify(updated));
  db.prepare('INSERT INTO meals VALUES(?,?)').run('meal','exact snapshot');
  const originals=Object.fromEntries(['users','profile_goals','meals'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  await migrateProfileVersions(db,dir);
  for(const [table,rows]of Object.entries(originals))assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),rows);
  assert.equal(db.prepare('SELECT count(*) n FROM profile_versions').get().n,3);
  const versions=db.prepare('SELECT * FROM profile_versions ORDER BY id').all();
  appendProfileVersion(db,'one',JSON.stringify({...updated,dailyCalories:2700}),'2026-10-29');
  appendProfileVersion(db,'one',JSON.stringify({...updated,dailyCalories:2800}),'2026-10-29');
  assert.deepEqual(db.prepare('SELECT * FROM profile_versions ORDER BY id LIMIT 3').all(),versions);
  assert.equal(JSON.parse(db.prepare("SELECT profile FROM profile_timeline WHERE user_id='one' AND date='2026-10-29'").get().profile).dailyCalories,2800);
  await migrateProfileVersions(db,dir);assert.equal(db.prepare('SELECT count(*) n FROM profile_versions').get().n,5);
  const files=await readdir(join(dir,'backups'));assert.equal(files.length,1);
  const snapshot=new DatabaseSync(join(dir,'backups',files[0]),{readOnly:true});
  try{for(const [table,rows]of Object.entries(originals))assert.deepEqual(snapshot.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),rows);assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{snapshot.close();}
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('profile API appends edits and historical day/history endpoints keep the effective profile across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'foodtrack-profile-api-'));
 let application=await createApplication({dataDir:dir}),server;
 const listen=async()=>{server=application.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return `http://127.0.0.1:${server.address().port}`;};
 let base=await listen();
 const request=async(path,cookie,body,method='GET')=>{
  const res=await fetch(base+path,{method,headers:{'X-Foodtrack':'1',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.ok(res.ok,`${path} ${res.status}`);return {data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
 };
 try{
  const registered=await request('/api/register',null,{username:'versioned-user',password:'profile-test-password'},'POST');
  const {id}=registered.data.user,cookie=registered.cookie;
  const current=today(),{start,end}=weekRange(current),yesterday=dateOffset(current,-1);
  const input={height:175,age:30,weight:80,targetWeight:75,gender:'male',activity:'moderate',targetDate:'2099-01-01'};
  const previous=calculateProfile(input,dateOffset(start,-7)),encoded=JSON.stringify(previous);
  application.db.prepare('UPDATE users SET profile=? WHERE id=?').run(encoded,id);
  appendProfileVersion(application.db,id,encoded,dateOffset(start,-7));
  application.db.prepare('INSERT INTO meals VALUES(?,?,?,?,?,?)').run('saved-meal',id,yesterday,'',JSON.stringify({calories:500,protein:10,fat:10,carbs:10}),new Date().toISOString());
  const oldRows=application.db.prepare('SELECT * FROM meals').all();
  const beforeHistory=(await request(`/api/history?days=30&end=${end}`,cookie)).data;
  const beforeDay=(await request(`/api/day?date=${yesterday}`,cookie)).data;
  await request('/api/profile',cookie,{...input,activity:'light'},'PUT');
  const newest=(await request('/api/profile',cookie,{...input,targetWeight:85,activity:'active'},'PUT')).data.profile;
  const afterHistory=(await request(`/api/history?days=30&end=${end}`,cookie)).data;
  assert.deepEqual(afterHistory.days.filter(d=>d.date<current),beforeHistory.days.filter(d=>d.date<current));
  assert.deepEqual((await request(`/api/day?date=${yesterday}`,cookie)).data,beforeDay);
  assert.equal((await request(`/api/day?date=${current}`,cookie)).data.week.profile.expenditure,newest.expenditure);
  const historyToday=afterHistory.days.find(d=>d.date===current);
  assert.equal(historyToday.maintenance.calories,newest.expenditure);
  assert.equal(application.db.prepare('SELECT count(*) n FROM profile_versions WHERE user_id=? AND date=?').get(id,current).n,2);
  assert.deepEqual(application.db.prepare('SELECT * FROM meals').all(),oldRows);
  const versions=application.db.prepare('SELECT * FROM profile_versions').all();
  await new Promise(r=>server.close(r));application.db.close();application=await createApplication({dataDir:dir});base=await listen();
  assert.deepEqual(application.db.prepare('SELECT * FROM profile_versions').all(),versions);
  assert.deepEqual((await request(`/api/day?date=${yesterday}`,cookie)).data,beforeDay);
 }finally{await new Promise(r=>server.close(r));application.db.close();await rm(dir,{recursive:true,force:true});}
});

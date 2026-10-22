import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateProfile } from '../server/nutrition.js';
import { migrateCaloriePolicy } from '../server/calorie-policy.js';

test('policy migration backs up old goals and updates only the current profile and today', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'foodtrack-policy-'));
 const db = new DatabaseSync(join(dir, 'test.sqlite'));
 try {
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,profile TEXT); CREATE TABLE profile_goals(user_id TEXT,date TEXT,profile TEXT,PRIMARY KEY(user_id,date)); CREATE TABLE meals(id TEXT,selected TEXT);');
  const legacy = calculateProfile({ height:175,age:30,weight:80,targetWeight:75,gender:'male',activity:'moderate',targetDate:'2026-10-19' },'2026-10-18');
  legacy.dailyCalories = 2211; delete legacy.caloriePolicyVersion;
  db.prepare('INSERT INTO users VALUES(?,?)').run('a',JSON.stringify(legacy));
  db.prepare('INSERT INTO profile_goals VALUES(?,?,?)').run('a','2026-10-18',JSON.stringify(legacy));
  db.prepare('INSERT INTO meals VALUES(?,?)').run('meal','original selection');
  const previousPolicy = { ...legacy, expenditure:2497, requestedCalories:847, dailyCalories:1500, caloriePolicyVersion:4 };
  db.prepare('INSERT INTO users VALUES(?,?)').run('b',JSON.stringify(previousPolicy));
  assert.equal(await migrateCaloriePolicy(db,dir,'2026-10-19'),2);
  assert.equal(JSON.parse(db.prepare("SELECT profile FROM users WHERE id='b'").get().profile).dailyCalories,1297);
  const current=JSON.parse(db.prepare("SELECT profile FROM users WHERE id='a'").get().profile);
  assert.equal(current.dailyCalories,1511);assert.equal(current.startDate,'2026-10-18');assert.equal(current.targetDate,legacy.targetDate);
  assert.equal(JSON.parse(db.prepare("SELECT profile FROM profile_goals WHERE user_id='a' AND date='2026-10-18'").get().profile).dailyCalories,2211);
  assert.equal(JSON.parse(db.prepare("SELECT profile FROM profile_goals WHERE user_id='a' AND date='2026-10-19'").get().profile).dailyCalories,1511);
  assert.equal(db.prepare('SELECT selected FROM meals').get().selected,'original selection');
  const files=await readdir(join(dir,'backups'));assert.equal(files.length,1);
  const snapshot=new DatabaseSync(join(dir,'backups',files[0]),{readOnly:true});try{assert.equal(JSON.parse(snapshot.prepare("SELECT profile FROM users WHERE id='a'").get().profile).dailyCalories,2211);}finally{snapshot.close();}
  assert.equal(await migrateCaloriePolicy(db,dir,'2026-10-20'),0);assert.equal((await readdir(join(dir,'backups'))).length,1);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

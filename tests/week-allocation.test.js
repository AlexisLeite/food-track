import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeek, buildHistory, dateOffset, weekRange } from '../server/history.js';
import { today } from '../server/nutrition.js';
import { createApplication } from '../server/app.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = { weight: 80, targetWeight: 75, expenditure: 2500, dailyCalories: 2000 };
const goals = [{ date: '2026-10-18', profile: JSON.stringify(profile) }];
const meal = (date, calories) => ({ date, selected: JSON.stringify({ calories }) });
const meals = [meal('2026-10-18',2600), meal('2026-10-19',1800), meal('2026-10-20',2200), meal('2026-10-21',800), meal('2026-10-22',5000)];

test('Wednesday through Saturday share the remaining budget, ignoring current and future intake', () => {
  for (const date of ['2026-10-21','2026-10-22','2026-10-23','2026-10-24']) {
    const budget = buildWeek({ date, asOf: '2026-10-21', meals, goals, profile });
    assert.equal(budget.dailyCalories,1850);
    assert.equal(budget.daysRemaining,4);
    assert.equal(budget.remaining,7400);
    assert.equal(budget.consumedBeforeDate,6600);
  }
  const history = buildHistory({ start:'2026-10-20', end:'2026-10-24', asOf:'2026-10-21', meals, goals });
  assert.equal(history.days[0].target.calories,1920);
  for (const day of history.days.slice(1)) {
    assert.equal(day.target.calories,1850);
    assert.equal(day.target.protein,138.8);
  }
  for (const date of ['2026-10-22','2026-10-23','2026-10-24']) {
    assert.equal(buildWeek({ date, asOf:'2026-10-22', meals, goals, profile }).dailyCalories,2200);
  }
});

test('future weeks restart on Sunday and the deficit limit applies equally to remaining days', () => {
  for (const date of ['2026-10-25','2026-10-28','2026-10-31']) {
    const budget = buildWeek({ date, asOf:'2026-10-21', meals, goals, profile });
    assert.equal(budget.dailyCalories,2000);
    assert.equal(budget.daysRemaining,7);
  }
  for (const date of ['2026-10-21','2026-10-24']) {
    const budget = buildWeek({ date, asOf:'2026-10-21', meals:[meal('2026-10-18',13000)], goals, profile });
    assert.equal(budget.dailyCalories,1300);
    assert.equal(budget.limited,true);
  }
});

test('day and history APIs use today when projecting all remaining days', async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'foodtrack-allocation-'));
  const { app, db } = await createApplication({ dataDir, origin:'http://localhost' });
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const registration = await fetch(`${base}/api/register`, { method:'POST', headers:{'Content-Type':'application/json','X-Foodtrack':'1'}, body:JSON.stringify({username:'allocation',password:'allocation-password'}) });
    assert.equal(registration.status,201);
    const cookie = registration.headers.get('set-cookie').split(';')[0];
    const { user } = await registration.json();
    const current = today(), { start, end } = weekRange(current);
    db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify(profile),user.id);
    db.prepare('INSERT INTO profile_goals VALUES(?,?,?)').run(user.id,start,JSON.stringify(profile));
    const daysRemaining = Math.round((Date.parse(end)-Date.parse(current))/86400000)+1;
    const expected = Math.round(14000/daysRemaining);
    for (let date = current; date <= end; date = dateOffset(date,1)) {
      const response = await fetch(`${base}/api/day?date=${date}`, {headers:{Cookie:cookie}});
      assert.equal(response.status,200);
      assert.equal((await response.json()).week.dailyCalories,expected);
    }
    const response = await fetch(`${base}/api/history?days=7&end=${end}`, {headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const history = await response.json();
    for (const day of history.days.filter(day => day.date >= current)) assert.equal(day.target.calories,expected);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApplication } from '../server/app.js';
import { calculateProfile, withMacroPlan } from '../server/nutrition.js';
import { getMacroPlan, getGoalProjection, getCalorieLimits, summarizeMeals } from '../public/nutrition.js';
import { validateAnalysis } from '../server/codex.js';
import { buildHistory, buildWeek, weekRange } from '../server/history.js';
const profile = { height: 175, age: 30, weight: 80, gender: 'male', activity: 'moderate', targetWeight: 75, targetDate: '2099-01-01' };
test('calorie calculation and impossible deadline limits', () => {
 const p = calculateProfile({ ...profile, targetDate: '2027-01-01' }, '2026-10-18');
 assert.equal(p.expenditure, 2711); assert.ok(p.dailyCalories < p.expenditure);
 const limited = calculateProfile({ ...profile, targetDate: '2026-10-19' }, '2026-10-18');
 assert.equal(limited.limited, true); assert.equal(limited.dailyCalories, 1511);
 assert.throws(() => calculateProfile({ ...profile, targetDate: '2026-02-30' }));
 assert.throws(() => calculateProfile({ ...profile, activity: 'toString' }));
 assert.throws(() => calculateProfile({ ...profile, weight: '80' }));
});
test('account isolation, persistent options, totals, retry and session revocation', async () => {
 const dataDir = await mkdtemp(join(tmpdir(), 'foodtrack-test-'));
 let calls = 0;
 const analyzer = async (_photo, instructions) => {
   calls++; if (instructions.endsWith('fail')) throw new Error('Prueba de análisis fallido');
   return { description: 'Comida de prueba', options: [{ name: 'Arroz', portion: '200 g', calories: calls * 100, protein: 10, fat: 2, carbs: 10, details: instructions || 'Plato pequeño' }, { name: 'Arroz grande', portion: '400 g', calories: 500, protein: 20, fat: 12, carbs: 78, details: 'Plato grande' }] };
 };
 const { app, db } = await createApplication({ dataDir, analyzer, descriptionAnalyzer: async (description) => { assert.equal(description, 'Dos huevos'); return { description: 'Huevos', options: [{ name: 'Huevos', portion: 'Dos unidades', calories: 142, protein: 12, fat: 10, carbs: 1, details: 'Sin aceite' }] }; }, origin: 'http://localhost' });
 const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
 const base = `http://127.0.0.1:${server.address().port}`;
 const request = async (url, { method = 'GET', body, cookie, origin, etag, csrf = true } = {}) => {
   const headers = {};
   if (csrf) headers['X-Foodtrack'] = '1';
   if (cookie) headers.Cookie = cookie;
   if (origin) headers.Origin = origin;
   if (etag) headers['If-None-Match'] = etag;
   if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
   const response = await fetch(base + url, { method, body, headers });
   const content = response.status === 304 ? null : response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
   return { status: response.status, body: content, etag: response.headers.get('etag'), cookie: response.headers.get('set-cookie')?.split(';')[0] };
 };
 try {
   assert.equal((await request('/api/me')).status, 401);
   assert.equal((await request('/api/register', { method: 'POST', body: { username: 'alice', password: 'passphrase-alice' }, csrf: false })).status, 403);
   const alice = await request('/api/register', { method: 'POST', body: { username: 'alice', password: 'passphrase-alice' } });
   assert.equal(alice.status, 201); const a = alice.cookie;
   assert.equal((await request('/api/me', { cookie: a })).body.user.username, 'alice');
   const bob = await request('/api/register', { method: 'POST', body: { username: 'bob', password: 'passphrase-bob' } }); const b = bob.cookie;
   assert.equal((await request('/api/login', { method: 'POST', body: { username: 'alice', password: 'not-the-password' } })).status, 401);
   assert.equal((await request('/api/profile', { method: 'PUT', body: profile, cookie: a, origin: 'https://evil.example' })).status, 403);
   const configured = await request('/api/profile', { method: 'PUT', body: profile, cookie: a });
   assert.equal(configured.status, 200); assert.equal(configured.body.profile.macroPlan.goal, 'lose');
   // Existing profiles gain macro goals without changing their saved daily calories or deadline.
   const legacyProfile = { ...configured.body.profile }; delete legacyProfile.macroPlan;
   db.prepare('UPDATE users SET profile=? WHERE username=?').run(JSON.stringify(legacyProfile), 'alice');
   const restoredProfile = (await request('/api/me', { cookie: a })).body.user.profile;
   assert.equal(restoredProfile.dailyCalories, legacyProfile.dailyCalories);
   assert.equal(restoredProfile.macroPlan.goal, 'lose');
   const gain = await request('/api/profile', { method: 'PUT', body: { ...profile, targetWeight: 85 }, cookie: a });
   assert.equal(gain.body.profile.macroPlan.goal, 'gain');
   const maintain = await request('/api/profile', { method: 'PUT', body: { ...profile, targetWeight: 80 }, cookie: a });
   assert.equal(maintain.body.profile.macroPlan.goal, 'maintain');
   // This fixed history fixture starts on Sunday, independently of the execution date.
   db.prepare('INSERT OR REPLACE INTO profile_goals VALUES(?,?,?)').run(alice.body.user.id, '2026-10-18', JSON.stringify(maintain.body.profile));
   const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
   const form = new FormData(); form.append('date', '2026-10-18'); form.append('photo', new Blob([image], { type: 'image/png' }), 'photo.png');
   const uploaded = await request('/api/meals', { method: 'POST', body: form, cookie: a }); assert.equal(uploaded.status, 201);
   const id = uploaded.body.meal.id;
   assert.equal((await request(`/api/meals/${id}/photo`, { cookie: b })).status, 404);
   assert.equal((await request(`/api/meals/${id}/analyze`, { method: 'POST', body: {}, cookie: b })).status, 404);
   const initial = await request(`/api/meals/${id}/analyze`, { method: 'POST', body: {}, cookie: a }); assert.equal(initial.status, 200);
   const analysisId = initial.body.meal.analyses[0].id;
   assert.equal((await request(`/api/meals/${id}/selection`, { method: 'PUT', body: { analysisId, optionIndex: 0, calories: 9999, protein: 9999 }, cookie: a })).status, 200);
   const initialRead = await request('/api/day?date=2026-10-18', { cookie: a });
   const initialDay = initialRead.body;
   assert.ok(initialRead.etag);
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a, etag: initialRead.etag })).status, 304);
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a, etag: `W/${initialRead.etag}` })).status, 304);
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a, etag: `"older", W/${initialRead.etag}` })).status, 304);
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: b, etag: initialRead.etag })).status, 200);
   assert.equal((await request('/api/day?date=2026-10-18', { etag: initialRead.etag })).status, 401);
   assert.equal(initialDay.total, 100);
   assert.equal(initialDay.week.total, 100);
   assert.equal(initialDay.week.target, maintain.body.profile.dailyCalories * 7);
   assert.equal(initialDay.week.start, '2026-10-18'); assert.equal(initialDay.week.end, '2026-10-24');
   const monday = await request('/api/day?date=2026-10-19', { cookie: a });
   assert.equal(monday.body.total, 0); assert.equal(monday.body.week.total, 100);
   assert.equal(monday.body.week.dailyCalories, Math.round((maintain.body.profile.dailyCalories * 7 - 100) / 6));
   const mondayHistory = await request('/api/history?days=7&end=2026-10-19', { cookie: a });
   assert.equal(mondayHistory.body.days.at(-1).target.calories, monday.body.week.dailyCalories);
   assert.equal((await request('/api/day?date=2026-10-19', { cookie: b })).body.week.total, 0);
   assert.deepEqual(initialDay.macros, { protein: 10, fat: 2, carbs: 10, missingMeals: 0 });
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: b })).body.total, 0);
   const reevaluated = await request(`/api/meals/${id}/analyze`, { method: 'POST', body: { instructions: 'Sin aceite' }, cookie: a }); assert.equal(reevaluated.body.meal.analyses.length, 2);
   assert.equal(reevaluated.body.meal.selected.calories, 100);
   assert.ok(reevaluated.body.meal.analyses[0].instructions.includes('Sin aceite'));
   await request(`/api/meals/${id}/selection`, { method: 'PUT', body: { analysisId, optionIndex: 1 }, cookie: a });
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a, etag: initialRead.etag })).status, 200);
   assert.deepEqual((await request('/api/day?date=2026-10-18', { cookie: a })).body.macros, { protein: 20, fat: 12, carbs: 78, missingMeals: 0 });
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a })).body.total, 500);
   assert.equal((await request('/api/day?date=2026-10-19', { cookie: a, etag: monday.etag })).status, 200);
   assert.equal((await request(`/api/meals/${id}/analyze`, { method: 'POST', body: { instructions: 'fail' }, cookie: a })).status, 502);
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a, etag: initialRead.etag })).status, 200);
   assert.deepEqual((await request('/api/day?date=2026-10-18', { cookie: a })).body.macros, { protein: 20, fat: 12, carbs: 78, missingMeals: 0 });
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a })).body.total, 500);
   assert.equal((await request(`/api/meals/${id}/selection`, { method: 'PUT', body: { analysisId, optionIndex: 999 }, cookie: a })).status, 400);
   assert.equal((await request('/api/day?date=2026-02-30', { cookie: a })).status, 400);
   assert.equal((await request(`/api/meals/${id}`, { method: 'DELETE', cookie: b })).status, 404);
   db.prepare('UPDATE meals SET selected=? WHERE id=?').run(JSON.stringify({ name: 'Comida antigua', portion: 'Un plato', calories: 500 }), id);
   const legacyDay = (await request('/api/day?date=2026-10-18', { cookie: a })).body;
   assert.equal(legacyDay.total, 500);
   assert.deepEqual(legacyDay.macros, { protein: 0, fat: 0, carbs: 0, missingMeals: 1 });
   await request(`/api/meals/${id}/selection`, { method: 'PUT', body: { analysisId, optionIndex: 0 }, cookie: a });
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a })).body.macros.missingMeals, 0);
   await request(`/api/meals/${id}`, { method: 'DELETE', cookie: a });
   assert.equal((await request('/api/day?date=2026-10-18', { cookie: a })).body.total, 0);
   assert.equal(db.prepare('SELECT count(*) AS n FROM analyses').get().n, 0);
   assert.equal((await request('/api/history?days=100000', { cookie: a })).status, 400);
   assert.equal((await request('/api/history?days=7&end=2026-02-30', { cookie: a })).status, 400);
   assert.equal((await request('/api/meals/describe', { method: 'POST', cookie: a, body: { date: '2026-10-18', description: ' ' } })).status, 400);
   const textMeal = await request('/api/meals/describe', { method: 'POST', cookie: a, body: { date: '2026-10-18', description: 'Dos huevos' } });
   assert.equal(textMeal.status, 201); assert.equal(textMeal.body.meal.photoUrl, null); assert.equal(textMeal.body.meal.description, 'Dos huevos');
   const textId = textMeal.body.meal.id;
   assert.equal((await request(`/api/meals/${textId}/photo`, { cookie: a })).status, 404);
   assert.equal((await request(`/api/meals/${textId}/analyze`, { method: 'POST', cookie: b, body: {} })).status, 404);
   const textAnalysis = await request(`/api/meals/${textId}/analyze`, { method: 'POST', cookie: a, body: {} });
   assert.equal(textAnalysis.status, 200);
   await request(`/api/meals/${textId}/selection`, { method: 'PUT', cookie: a, body: { analysisId: textAnalysis.body.meal.analyses[0].id, optionIndex: 0 } });
   const history = await request('/api/history?days=7&end=2026-10-18', { cookie: a });
   assert.equal((await request('/api/history?days=7&end=2026-10-18', { cookie: a, etag: history.etag })).status, 304);
   assert.equal(history.body.days.length, 7); assert.equal(history.body.days.at(-1).actual.calories, 142); assert.equal(history.body.days.at(-1).actual.protein, 12);
   const otherHistory = await request('/api/history?days=7&end=2026-10-18', { cookie: b });
   assert.equal(otherHistory.body.days.at(-1).actual.calories, null);
   assert.equal((await request(`/api/meals/${textId}`, { method: 'DELETE', cookie: a })).status, 200);
   assert.equal(db.prepare('SELECT count(*) n FROM meal_descriptions').get().n, 0);
   await request('/api/logout', { method: 'POST', cookie: a });
   assert.equal((await request('/api/me', { cookie: a })).status, 401);
   const login = await request('/api/login', { method: 'POST', body: { username: 'alice', password: 'passphrase-alice' } }); assert.equal(login.status, 200);
 } finally { await new Promise(r => server.close(r)); db.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('macro plans infer weight direction and match the daily energy budget', () => {
 const cases = [
  { targetWeight: 75, goal: 'lose', protein: 150, fat: 55.6, carbs: 225 },
  { targetWeight: 85, goal: 'gain', protein: 125, fat: 55.6, carbs: 250 },
  { targetWeight: 80, goal: 'maintain', protein: 100, fat: 66.7, carbs: 250 }
 ];
 for (const { targetWeight, goal, protein, fat, carbs } of cases) {
   const plan = getMacroPlan({ weight: 80, targetWeight, dailyCalories: 2000 });
   assert.equal(plan.goal, goal); assert.equal(plan.protein, protein); assert.equal(plan.fat, fat); assert.equal(plan.carbs, carbs);
   assert.ok(Math.abs(plan.protein * 4 + plan.fat * 9 + plan.carbs * 4 - 2000) < 1);
 }
 const profile = withMacroPlan({ weight: 80, targetWeight: 75, dailyCalories: 1800, macroPlan: { protein: 9999 } });
 assert.equal(profile.macroPlan.protein, 135);
 assert.deepEqual(summarizeMeals([{ selected: { calories: 200, protein: 10.1, fat: 2.2, carbs: 30.3 } }, { selected: { calories: 100 } }, { selected: null }]), { calories: 300, protein: 10.1, fat: 2.2, carbs: 30.3, missingMacros: 1, knownMeals: 1 });
});
test('new analyses require numeric nonnegative macros; nonfood may return no options', () => {
 const option = { name: 'Arroz', portion: 'Un plato', calories: 200, protein: 5.2, fat: 2, carbs: 40.3, details: 'Estimado' };
 const analysis = options => ({ description: 'Un plato', options });
 assert.equal(validateAnalysis(analysis([option])).options[0].protein, 5.2);
 assert.deepEqual(validateAnalysis(analysis([])).options, []);
 for (const key of ['protein', 'fat', 'carbs']) {
   for (const value of [undefined, null, '10', -1, NaN, Infinity, 2501]) assert.throws(() => validateAnalysis(analysis([{ ...option, [key]: value }])));
 }
});

test('history preserves goal changes and distinguishes missing data from zero', () => {
 const goal = calories => JSON.stringify({ weight: 80, targetWeight: 75, dailyCalories: calories });
 const selected = value => JSON.stringify(value);
 const history = buildHistory({ start: '2026-10-15', end: '2026-10-19', goals: [{ date: '2026-10-16', profile: goal(2000) }, { date: '2026-10-18', profile: goal(1800) }], meals: [
  { date: '2026-10-16', selected: selected({ calories: 100, protein: 5, fat: 2, carbs: 15 }) },
  { date: '2026-10-16', selected: selected({ calories: 200, protein: 10, fat: 4, carbs: 30 }) },
  { date: '2026-10-17', selected: null },
  { date: '2026-10-18', selected: selected({ calories: 0, protein: 0, fat: 0, carbs: 0 }) },
  { date: '2026-10-19', selected: selected({ calories: 150 }) }
 ] });
 assert.equal(history.days[0].target, null); assert.equal(history.days[0].actual.calories, null);
 assert.equal(history.days[1].target.calories, 7000); assert.equal(history.days[1].actual.calories, 300); assert.equal(history.days[1].actual.protein, 15);
 assert.equal(history.days[2].actual.calories, null); assert.equal(history.days[2].pendingMeals, 1);
 assert.equal(history.days[3].actual.calories, 0); assert.equal(history.days[3].target.calories, 1800);
 assert.equal(history.days[4].actual.calories, 150); assert.equal(history.days[4].actual.protein, null);
});

test('weekly totals use Sunday to Saturday and preserve daily goal changes', () => {
 const profile = { weight: 80, targetWeight: 75, dailyCalories: 2000 };
 assert.deepEqual(weekRange('2027-01-02'), { start: '2026-12-27', end: '2027-01-02' });
 assert.deepEqual(weekRange('2027-01-03'), { start: '2027-01-03', end: '2027-01-09' });
 const summary = buildWeek({ date: '2026-10-18', profile, goals: [{ date: '2026-10-21', profile: JSON.stringify({ ...profile, dailyCalories: 1800 }) }], meals: [
  { date: '2026-10-17', selected: JSON.stringify({ calories: 9999 }) },
  { date: '2026-10-18', selected: JSON.stringify({ calories: 300 }) },
  { date: '2026-10-21', selected: null },
  { date: '2026-10-24', selected: JSON.stringify({ calories: 700 }) },
  { date: '2026-10-25', selected: JSON.stringify({ calories: 9999 }) }
 ] });
 assert.deepEqual(summary, { start: '2026-10-18', end: '2026-10-24', total: 1000, target: 13200, consumedBeforeDate: 0, daysRemaining: 7, remaining: 13200, rawDailyCalories: 13200 / 7, dailyCalories: 1886, minimumDailyCalories: 0, limited: false });
});

test('projections show deadline weight and time to goal for loss, gain and maintenance', () => {
 const base = { weight: 80, targetWeight: 75, expenditure: 2497, dailyCalories: 1997, startDate: '2026-10-18', targetDate: '2026-10-28' };
 const loss = getGoalProjection(base);
 assert.equal(loss.projectedWeight, 79.4); assert.equal(loss.estimatedDays, 77); assert.equal(loss.estimatedTargetDate, '2027-01-03');
 const gain = getGoalProjection({ ...base, targetWeight: 85, dailyCalories: 2997 });
 assert.equal(gain.projectedWeight, 80.6); assert.equal(gain.estimatedDays, 77); assert.equal(gain.estimatedTargetDate, '2027-01-03');
 assert.equal(getGoalProjection({ ...base, dailyCalories: 2497 }).estimatedTargetDate, null);
 assert.equal(getGoalProjection({ ...base, targetWeight: 80, dailyCalories: 2497 }).estimatedDays, 0);
 assert.equal(getGoalProjection({ ...base, startDate: null }), null);
 assert.equal(withMacroPlan(base).projection.estimatedTargetDate, loss.estimatedTargetDate);
});

test('daily budget spends only prior days and includes today in remaining days', () => {
 const profile = { weight: 80, targetWeight: 75, dailyCalories: 2000 };
 const goals = [{ date: '2026-10-18', profile: JSON.stringify(profile) }];
 const meal = (date,calories) => ({ date, selected: JSON.stringify({ calories, protein: 20, fat: 10, carbs: 30 }) });
 const meals = [meal('2026-10-18',2600),meal('2026-10-19',800),meal('2026-10-24',1000)];
 const sunday = buildWeek({ date:'2026-10-18', meals,goals,profile });
 assert.equal(sunday.dailyCalories,2000); assert.equal(sunday.daysRemaining,7); assert.equal(sunday.consumedBeforeDate,0);
 const monday = buildWeek({ date:'2026-10-19', meals,goals,profile });
 assert.equal(monday.dailyCalories,1900); assert.equal(monday.daysRemaining,6); assert.equal(monday.remaining,11400);
 const saturday = buildWeek({ date:'2026-10-24', meals,goals,profile });
 assert.equal(saturday.dailyCalories,10600); assert.equal(saturday.daysRemaining,1);
 const exhausted = buildWeek({ date:'2026-10-19', meals:[meal('2026-10-18',15000)],goals,profile });
 assert.equal(exhausted.rawDailyCalories,-1000/6); assert.equal(exhausted.dailyCalories,0);
 const history = buildHistory({ start:'2026-10-19', end:'2026-10-19', meals,goals });
 assert.equal(history.days[0].target.calories,1900); assert.equal(history.days[0].actual.calories,800);
 assert.equal(history.days[0].target.protein,142.5);
 const next = buildWeek({ date:'2026-10-25', meals,goals,profile });
 assert.equal(next.dailyCalories,2000); assert.equal(next.total,0);
});

test('deficit is capped at 1200 without fixed intake floors', () => {
 assert.deepEqual(getCalorieLimits({ expenditure: 2497, gender: 'male' }), { minimum: 1297, maximum: 2997 });
 assert.equal(getCalorieLimits({ expenditure: 3000, gender: 'male' }).minimum, 1800);
 assert.equal(getCalorieLimits({ expenditure: 1800, gender: 'male' }).minimum, 600);
 assert.equal(getCalorieLimits({ expenditure: 1800, gender: 'female' }).minimum, 600);
 const gain = calculateProfile({ ...profile, targetWeight: 90, targetDate: '2026-10-19' }, '2026-10-18');
 assert.equal(gain.dailyCalories, gain.expenditure + 500);
 const p = { weight:80, targetWeight:75, gender:'male', expenditure:2497, dailyCalories:1500 };
 const budget = buildWeek({ date:'2026-10-19', profile:p, goals:[], meals:[{date:'2026-10-18',selected:JSON.stringify({calories:12000})}] });
 assert.equal(budget.dailyCalories,1297);assert.equal(budget.minimumDailyCalories,1297);assert.equal(budget.limited,true);
 const uncapped = calculateProfile({ ...profile, targetDate:'2026-11-15' }, '2026-10-18');
 assert.equal(uncapped.dailyCalories,1511);assert.equal(uncapped.expenditure-uncapped.dailyCalories,1200);assert.equal(uncapped.limited,true);
 const redistributed=buildWeek({date:'2026-10-19',profile:p,goals:[],meals:[{date:'2026-10-18',selected:JSON.stringify({calories:3000})}]});
 assert.equal(redistributed.dailyCalories,1297);assert.equal(redistributed.limited,true);
});

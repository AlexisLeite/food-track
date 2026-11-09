import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from './helpers/application.js';
import { calculateProfile, today } from '../server/nutrition.js';
import { workoutEstimate, workoutOptions } from '../server/workouts.js';
import { buildWeek, buildHistory, dateOffset, weekRange } from '../server/history.js';
import { rollingWeekProgress } from '../public/week-progress.js';
const input = {
  height: 175,
  age: 30,
  weight: 80,
  targetWeight: 75,
  gender: 'male',
  activity: 'moderate',
  targetDate: '2027-01-01'
};
const result = {
  details: 'Intensidad moderada; gasto neto sobre el reposo.',
  activities: [{
    name: 'Caminar',
    minutes: 60,
    met: 4
  }]
};
const alternatives = {
  options: [30, 60, 90].map(minutes => ({
    name: `Caminata de ${minutes} minutos`,
    ...result,
    activities: [{
      name: 'Caminar',
      minutes,
      met: 4
    }]
  }))
};
test('new profiles default to ten percent; forty is the product ceiling, including weekly redistribution', () => {
  for (const percent of [0, 10, 40]) {
    const p = calculateProfile({
      ...input,
      maxDailyDeficitPercent: percent,
      targetDate: '2026-10-19'
    }, '2026-10-18');
    assert.equal(p.maxDailyDeficitPercent, percent);
    assert.equal(p.dailyCalories, Math.ceil(p.expenditure * (1 - percent / 100)));
    const budget = buildWeek({
      date: '2026-10-19',
      profile: p,
      goals: [],
      meals: [{
        date: '2026-10-18',
        selected: JSON.stringify({
          calories: 20000
        })
      }]
    });
    assert.equal(budget.dailyCalories, p.dailyCalories);
  }
  assert.equal(calculateProfile(input, '2026-10-18').maxDailyDeficitPercent, 10);
  for (const bad of [-1, 41, '10', NaN, Infinity]) assert.throws(() => calculateProfile({
    ...input,
    maxDailyDeficitPercent: bad
  }, '2026-10-18'));
  const estimated = calculateProfile(input, '2026-10-18');
  const detailed = calculateProfile({
    ...input,
    expenditureMode: 'workouts',
    dailyActivity: 'sedentary'
  }, '2026-10-18');
  assert.equal(detailed.expenditure, 2099);
  assert.equal(estimated.expenditure, 2711);
  assert.equal(calculateProfile({
    ...input,
    activity: 'very_active',
    expenditureMode: 'workouts',
    dailyActivity: 'sedentary'
  }, '2026-10-18').expenditure, detailed.expenditure);
  assert.throws(() => calculateProfile({
    ...input,
    expenditureMode: 'exact'
  }, '2026-10-18'));
  assert.throws(() => calculateProfile({
    ...input,
    dailyActivity: 'unknown'
  }, '2026-10-18'));
});
test('exercise estimation uses weight and subtracts resting energy; malformed and missing duration responses fail', () => {
  const estimate = workoutEstimate(result, 80);
  assert.equal(estimate.calories, 252);
  assert.equal(estimate.weight, 80);
  assert.throws(() => workoutEstimate({
    ...result,
    activities: []
  }, 80));
  for (const bad of [{
    minutes: 0
  }, {
    minutes: NaN
  }, {
    met: 30
  }, {
    name: 'x',
    minutes: 800
  }, {
    met: '4'
  }]) assert.throws(() => workoutEstimate({
    ...result,
    activities: [{
      ...result.activities[0],
      ...bad
    }]
  }, 80));
});
test('confirmed workouts add only to their day, carry unused weekly calories forward and enter a rolling seven-day balance', () => {
  const start = '2026-11-01',
    end = '2026-11-14',
    current = '2026-11-06';
  const p = {
    ...input,
    expenditure: 2000,
    dailyCalories: 1800,
    maxDailyDeficitPercent: 10,
    expenditureMode: 'workouts'
  };
  const goals = [{
    date: start,
    profile: JSON.stringify(p)
  }];
  const workouts = [{
    date: current,
    confirmed: true,
    calories: 300
  }, {
    date: current,
    confirmed: false,
    calories: 900
  }];
  const meals = Array.from({
    length: 14
  }, (_, i) => ({
    date: dateOffset(start, i),
    selected: JSON.stringify({
      calories: 1800,
      protein: 100,
      fat: 60,
      carbs: 215
    })
  }));
  const budget = buildWeek({
    date: current,
    goals,
    profile: p,
    meals,
    workouts,
    asOf: end
  });
  assert.equal(budget.dailyCalories, 2100);
  assert.equal(budget.exerciseCalories, 300);
  assert.equal(budget.target, 7 * 1800 + 300);
  assert.equal(budget.maintenance, 7 * 2000 + 300);
  const history = buildHistory({
    start,
    end,
    goals,
    meals,
    workouts,
    asOf: end
  });
  assert.equal(history.days[5].maintenance.calories, 2300);
  assert.equal(history.days[4].maintenance.calories, 2000);
  assert.equal(history.days[5].target.calories, 2100);
  const rolling = rollingWeekProgress(history.days, end);
  assert.equal(rolling.get('2026-11-08').maintenance, 7 * 2000 + 300);
  assert.equal(rolling.get('2026-11-12').maintenance, 7 * 2000 + 300);
  assert.equal(rolling.get('2026-11-13').maintenance, 7 * 2000);
  const estimated = [{
    date: start,
    profile: JSON.stringify({
      ...p,
      expenditureMode: 'estimated'
    })
  }];
  assert.equal(buildHistory({
    start,
    end,
    goals: estimated,
    meals,
    workouts,
    asOf: end
  }).days[5].maintenance.calories, 2000);
  const spent = meals.map(m => m.date === current ? {
    ...m,
    selected: JSON.stringify({
      calories: 2100
    })
  } : m);
  assert.equal(buildWeek({
    date: '2026-11-07',
    goals,
    profile: p,
    meals: spent,
    workouts,
    asOf: end
  }).dailyCalories, 1800);
});
test('workouts are private, authorized, idempotent, confirmed explicitly, persisted and removable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foodtrack-workouts-'));
  let application,
    server,
    calls = 0;
  const analyzer = async () => {
    calls++;
    return alternatives;
  };
  const start = async () => {
    application = await createApplication({
      dataDir: dir,
      workoutAnalyzer: analyzer
    });
    server = application.app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
  };
  const req = async (path, {
    method = 'GET',
    cookie,
    body,
    hash
  } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        'X-Foodtrack': '1',
        'Content-Type': 'application/json',
        ...(cookie ? {
          Cookie: cookie
        } : {}),
        ...(hash ? {
          'X-Submission-ID': hash
        } : {})
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {})
    });
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0]
    };
  };
  try {
    await start();
    const a = await req('/api/register', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'test-password-a'
      }
    });
    const b = await req('/api/register', {
      method: 'POST',
      body: {
        username: 'bobby',
        password: 'test-password-b'
      }
    });
    const config = {
      ...input,
      targetDate: dateOffset(today(), 60),
      expenditureMode: 'workouts',
      dailyActivity: 'sedentary'
    };
    await req('/api/profile', {
      method: 'PUT',
      cookie: a.cookie,
      body: config
    });
    const body = {
      date: today(),
      description: 'Caminé 60 minutos a paso moderado'
    };
    assert.equal((await req('/api/workouts', {
      method: 'POST',
      cookie: a.cookie,
      body
    })).status, 403);
    await application.db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(a.body.user.id);
    const hash = 'a'.repeat(64);
    const first = await req('/api/workouts', {
      method: 'POST',
      cookie: a.cookie,
      body,
      hash
    });
    assert.equal(first.status, 201);
    const id = first.body.workout.id;
    assert.equal(first.body.workout.calories, 0);
    assert.equal(first.body.workout.estimate.options[1].calories, 252);
    const retry = await req('/api/workouts', {
      method: 'POST',
      cookie: a.cookie,
      body,
      hash
    });
    assert.equal(retry.body.workout.id, id);
    assert.equal(calls, 1);
    assert.equal((await req(`/api/workouts/${id}/confirm`, {
      method: 'PUT',
      cookie: b.cookie,
      body: {}
    })).status, 404);
    assert.equal((await req('/api/workouts', {
      cookie: b.cookie
    })).body.workouts.length, 0);
    const before = await req(`/api/day?date=${today()}`, {
      cookie: a.cookie
    });
    assert.equal(before.body.week.exerciseCalories, 0);
    for (const optionIndex of [undefined, -1, 3, '1', 0.5]) assert.equal((await req(`/api/workouts/${id}/confirm`, {
      method: 'PUT',
      cookie: a.cookie,
      body: {
        optionIndex
      }
    })).status, 400);
    const confirmed = await req(`/api/workouts/${id}/confirm`, {
      method: 'PUT',
      cookie: a.cookie,
      body: {
        optionIndex: 1,
        calories: 99999
      }
    });
    assert.equal(confirmed.body.workout.calories, 252);
    await req(`/api/workouts/${id}/confirm`, {
      method: 'PUT',
      cookie: a.cookie,
      body: {}
    });
    const after = await req(`/api/day?date=${today()}`, {
      cookie: a.cookie
    });
    assert.equal(after.body.week.exerciseCalories, 252);
    assert.equal(after.body.week.dailyCalories, before.body.week.dailyCalories + 252);
    const history = await req(`/api/history?days=7&end=${today()}`, {
      cookie: a.cookie
    });
    assert.equal(history.body.days.at(-1).maintenance.calories, after.body.week.profile.expenditure + 252);
    const changed = await req(`/api/workouts/${id}/confirm`, {
      method: 'PUT',
      cookie: a.cookie,
      body: {
        optionIndex: 2
      }
    });
    assert.equal(changed.body.workout.calories, 378);
    assert.equal(changed.body.workout.estimate.selectedIndex, 2);
    assert.equal((await req(`/api/day?date=${today()}`, {
      cookie: a.cookie
    })).body.week.exerciseCalories, 378);
    await req(`/api/workouts/${id}/confirm`, {
      method: 'PUT',
      cookie: a.cookie,
      body: {
        optionIndex: 1
      }
    });
    await application.db.prepare('INSERT INTO workouts(id,user_id,date,description,estimate,created_at) VALUES(?,?,?,?,?,?)').run('legacy', a.body.user.id, today(), 'Entrenamiento anterior', JSON.stringify(workoutEstimate(result, 80)), new Date().toISOString());
    const legacy = await req('/api/workouts/legacy/confirm', {
      method: 'PUT',
      cookie: a.cookie,
      body: {}
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.workout.calories, 252);
    await req('/api/workouts/legacy', {
      method: 'DELETE',
      cookie: a.cookie
    });
    await application.db.prepare('UPDATE users SET enable_codex_extraction=0 WHERE id=?').run(a.body.user.id);
    assert.equal((await req('/api/workouts', {
      method: 'POST',
      cookie: a.cookie,
      body,
      hash
    })).status, 403);
    await new Promise(r => server.close(r));
    await application.db.close();
    await start();
    assert.equal((await req('/api/workouts', {
      cookie: a.cookie
    })).body.workouts[0].calories, 252);
    assert.equal((await req(`/api/workouts/${id}`, {
      method: 'DELETE',
      cookie: b.cookie
    })).status, 404);
    assert.equal((await req(`/api/workouts/${id}`, {
      method: 'DELETE',
      cookie: a.cookie
    })).status, 200);
    assert.equal((await req(`/api/day?date=${today()}`, {
      cookie: a.cookie
    })).body.week.exerciseCalories, 0);
  } finally {
    if (server?.listening) await new Promise(r => server.close(r));
    application?.db.close();
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});
test('incomplete workouts produce three bounded alternatives, calculated separately without counting all options', () => {
  const input = {
    options: [4, 6, 8].map(minutes => ({
      name: `3 series de 6 dominadas en ${minutes} min`,
      details: '18 repeticiones; duración y descansos supuestos para este bloque.',
      activities: [{
        name: 'Dominadas con descansos',
        minutes,
        met: 3.5
      }]
    }))
  };
  const estimate = workoutOptions(input, 80);
  assert.equal(estimate.selectedIndex, null);
  assert.equal(estimate.options.length, 3);
  assert.deepEqual(estimate.options.map(o => o.calories), [14, 21, 28]);
  assert.equal(estimate.calories, undefined);
  for (const bad of [null, {
    options: []
  }, {
    options: input.options.slice(0, 2)
  }, {
    options: [...input.options, input.options[0]]
  }, {
    options: input.options.map(o => ({
      ...o,
      activities: []
    }))
  }]) assert.throws(() => workoutOptions(bad, 80));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory } from '../server/history.js';
import { historyChart } from '../public/history.js';

test('maintenance uses expenditure independently of the weekly calorie target', () => {
  const base = { weight:80, targetWeight:75, dailyCalories:1500, expenditure:2500 };
  const history = buildHistory({ start:'2026-10-18', end:'2026-10-20', meals:[], goals:[
    { date:'2026-10-18', profile:JSON.stringify(base) },
    { date:'2026-10-20', profile:JSON.stringify({...base,expenditure:2400}) }
  ] });
  assert.deepEqual(history.days.map(day=>day.maintenance.calories),[2500,2500,2400]);
  const chart = historyChart(history,'calories');
  assert.match(chart,/class="chart-maintenance"/);
  assert.match(chart,/legend-maintenance/);
  assert.doesNotMatch(chart,/class="chart-point-maintenance"/);
  // The maintenance line must be included when calculating the vertical scale.
  assert.match(chart,/>2.800<\/text>/);
  assert.doesNotMatch(historyChart(history,'protein'),/class="chart-maintenance"|legend-maintenance/);
});

test('history without known expenditure does not invent a maintenance value', () => {
  const history = buildHistory({ start:'2026-10-18', end:'2026-10-19', meals:[], goals:[{date:'2026-10-19',profile:JSON.stringify({weight:80,targetWeight:75,dailyCalories:1500})}] });
  assert.ok(history.days.every(day=>day.maintenance===null));
  assert.doesNotMatch(historyChart(history,'calories'),/class="chart-maintenance"|legend-maintenance/);
});

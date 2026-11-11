import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory } from '../server/history.js';
import { historyChart, chartRange } from '../public/history.js';

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
  const range=chartRange([1500,2500,2400]);
  assert.ok(range.min>0 && range.max>=2500);
  assert.doesNotMatch(historyChart(history,'protein'),/class="chart-maintenance"|legend-maintenance/);
});

test('history without known expenditure does not invent a maintenance value', () => {
  const history = buildHistory({ start:'2026-10-18', end:'2026-10-19', meals:[], goals:[{date:'2026-10-19',profile:JSON.stringify({weight:80,targetWeight:75,dailyCalories:1500})}] });
  assert.ok(history.days.every(day=>day.maintenance===null));
  assert.doesNotMatch(historyChart(history,'calories'),/class="chart-maintenance"|legend-maintenance/);
});


test('vertical scale fits visible values with padding and handles flat, zero and missing ranges',()=>{
 const range=chartRange([950,1700,2200,null,undefined,NaN,Infinity]);
 assert.ok(range.min>700 && range.min<950);assert.ok(range.max>2200 && range.max<2450);
 assert.ok(range.ticks.length>=4);assert.ok(range.ticks.every(t=>t>=range.min && t<=range.max));
 for(const values of [[2000,2000],[0,0],[],[null,NaN],[-100,20]]){
  const r=chartRange(values);assert.ok(Number.isFinite(r.min)&&Number.isFinite(r.max)&&r.max>r.min);
  assert.ok(r.ticks.length>0);assert.ok(values.filter(Number.isFinite).every(v=>v>=r.min&&v<=r.max));
 }
});

test('calorie scale excludes hidden daily spikes but includes the visible rolling balance',()=>{
 const days=Array.from({length:7},(_,i)=>({date:`2026-11-0${i+1}`,actual:{calories:i===6?10000:1800},target:{calories:1800},maintenance:{calories:2400},meals:1}));
 const chart=historyChart({start:days[0].date,end:days.at(-1).date,days},'calories',{asOf:'2026-11-07'});
 assert.doesNotMatch(chart,/>0<\/text>|>10.000<\/text>/);
 const path=chart.match(/<path d="([^"]*)" class="chart-week-progress"/)[1];
 const ys=[...path.matchAll(/[-\d.]+,([-\d.]+)/g)].map(m=>Number(m[1]));
 assert.ok(ys.length>0 && ys.every(y=>y>=18&&y<=204));
 const above=historyChart({start:'2026-11-07',end:'2026-11-07',days:[days.at(-1)]},'calories',{asOf:'2026-11-07'});
 const circle=above.match(/<circle cx="[^"]*" cy="([^"]*)" r="2.5"/);
 assert.ok(circle && Number(circle[1])>=18 && Number(circle[1])<=204);
});

test('missing chart values interpolate between neighbors and extend the nearest value at either edge', async () => {
 const { interpolateMissingValues: fill } = await import('../public/history.js');
 assert.deepEqual(fill([null,10,null,null,40,null,null]),[10,10,20,30,40,40,40]);
 assert.deepEqual(fill([null,null,12,null]),[12,12,12,12]);
 assert.deepEqual(fill([30,null,null,0]),[30,20,10,0]);
 assert.deepEqual(fill([0,null,20,null,0]),[0,10,20,10,0]);
 assert.deepEqual(fill([null,undefined,NaN,Infinity]),[null,null,null,null]);
 assert.deepEqual(fill([]),[]);
 const source=[null,10,null,30];fill(source);assert.deepEqual(source,[null,10,null,30]);
});

test('nutrient chart bridges missing days without adding recorded points or changing the table', () => {
 const values=[null,10,null,null,40,null,null];
 const days=values.map((value,i)=>({date:`2026-11-0${i+1}`,actual:{protein:value},target:{protein:50},meals:value===null?0:1}));
 const history={start:days[0].date,end:days.at(-1).date,days};
 const original=structuredClone(history),chart=historyChart(history,'protein');
 const path=chart.match(/<path d="([^"]*)" class="chart-actual"/)[1];
 assert.equal((path.match(/M/g)||[]).length,1);
 assert.equal((path.match(/C/g)||[]).length,6);
 assert.equal((chart.match(/class="chart-point-actual"/g)||[]).length,2);
 assert.equal((chart.match(/>Sin registro<\/td>/g)||[]).length,5);
 assert.doesNotMatch(chart,/Los huecos/);
 assert.deepEqual(history,original);
 const empty=historyChart({...history,days:days.map(day=>({...day,actual:{protein:null},meals:0}))},'protein');
 assert.match(empty,/<path d="" class="chart-actual"/);
 assert.match(empty,/Todavía no hay registros/);
});

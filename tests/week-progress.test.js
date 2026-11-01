import test from 'node:test';
import assert from 'node:assert/strict';
import { rollingWeekProgress } from '../public/week-progress.js';
import { historyChart } from '../public/history.js';
const offset = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0,10);
const day = (date, calories) => ({date, actual:{calories}, target:{calories:1800}, maintenance:{calories:2400}, meals:calories===null?0:1, pendingMeals:0});
const days = Array.from({length:40},(_,i)=>day(offset('2026-10-01',i),1800));

test('each point includes exactly seven calendar days and does not reset on Sunday',()=>{
 const input=days.map(d=>({...d,actual:{calories:d.date==='2026-10-26'?9000:1800}}));
 const points=rollingWeekProgress(input,'2026-11-02');
 assert.equal(points.get('2026-11-01').consumed,9000+6*1800);
 assert.equal(points.get('2026-11-01').start,'2026-10-26');
 assert.equal(points.get('2026-11-02').consumed,7*1800);
 assert.equal(points.get('2026-11-01').maintenance,7*2400);
 assert.equal(points.get('2026-11-02').provisional,true);
 assert.equal(points.has('2026-11-03'),false);
});

test('rolling goal and maintenance anchors respect changes in configuration',()=>{
 for(const source of ['target','maintenance']){
  const input=days.map((d,i)=>({...d,target:{calories:1500+i*10},maintenance:{calories:2300+i*10},actual:{calories:source==='target'?1500+i*10:2300+i*10}}));
  const points=rollingWeekProgress(input,'2026-11-01');
  for(const [date,point] of points){
   const entry=input.find(d=>d.date===date);
   assert.ok(Math.abs(point.value-entry[source].calories)<1e-8);
  }
 }
});

test('missing days are excluded rather than counted as zero and pending meals are identified',()=>{
 const input=days.map(d=>({...d,actual:{calories:d.date==='2026-10-28'?null:2400},pendingMeals:d.date==='2026-10-29'?1:0}));
 const points=rollingWeekProgress(input,'2026-11-01');
 const last=points.get('2026-11-01');
 assert.equal(last.missingDays,1);assert.equal(last.pendingDays,1);
 assert.equal(last.consumed,6*2400);assert.equal(last.balance,0);assert.equal(last.value,2400);
 assert.equal(points.has('2026-10-28'),false);
});

test('overlay covers at most 28 days and respects a selected historical end date',()=>{
 const points=rollingWeekProgress(days,'2026-11-05',undefined,'2026-11-01');
 assert.equal(points.size,28);
 assert.equal(points.keys().next().value,'2026-10-05');
 assert.equal([...points.keys()].at(-1),'2026-11-01');
 assert.equal(points.get('2026-11-01').provisional,false);
});

test('clipped chart includes hidden six-day context and remains continuous across Sunday',()=>{
 const visible=days.filter(d=>d.date>='2026-10-30' && d.date<='2026-11-02');
 const history={start:visible[0].date,end:visible.at(-1).date,days:visible,balanceDays:days};
 const chart=historyChart(history,'calories',{asOf:'2026-11-02'});
 assert.match(chart,/balance registrado -4\.200 kcal/);
 assert.match(chart,/Últimos 7 días/);
 assert.match(chart,/Balance últimos 7 días/);
 const path=chart.match(/<path d="([^"]*)" class="chart-week-progress"/)[1];
 assert.equal((path.match(/M/g)||[]).length,1);
 assert.equal((path.match(/C/g)||[]).length,3);
 assert.doesNotMatch(historyChart(history,'protein',{asOf:'2026-11-02'}),/chart-week-progress/);
 const original=historyChart(history,'calories',{asOf:'2026-09-01'});
 const stripped=chart.replace(/<path d="[^"]*" class="chart-week-progress"><title>[^<]*<\/title><\/path>/g,'');
 assert.equal(stripped,original);
});

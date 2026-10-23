import test from 'node:test';
import assert from 'node:assert/strict';
import { currentWeekProgress } from '../public/week-progress.js';
import { historyChart } from '../public/history.js';
const day=(date,calories)=>({date,actual:{calories},target:{calories:1800},maintenance:{calories:2400},meals:calories===null?0:1,pendingMeals:0});
const days=[day('2026-10-17',90000),...Array.from({length:7},(_,i)=>day(`2026-10-${18+i}`,i<6?1000:80000))];

test('weekly ratio starts Sunday, excludes other weeks and future days, and uses maintenance as its 100% reference',()=>{
 const points=currentWeekProgress(days,'2026-10-23',2400);
 assert.equal(points.size,6);assert.equal(points.has('2026-10-17'),false);assert.equal(points.has('2026-10-24'),false);
 assert.equal(points.get('2026-10-18').consumed,1000);
 assert.equal(points.get('2026-10-23').consumed,6000);
 assert.equal(points.get('2026-10-23').maintenance,14400);
 assert.equal(points.get('2026-10-23').ratio,6000/14400);
 assert.equal(points.get('2026-10-23').value,1000);
 const full=days.slice(1).map(d=>({...d,actual:{calories:2400}}));
 assert.equal(currentWeekProgress(full,'2026-10-24',2400).get('2026-10-24').value,2400);
 assert.equal(currentWeekProgress(days,'2026-10-25',2400).size,0);
});

test('adding the red overlay leaves every existing line, axis, tick, table and label identical',()=>{
 const history={start:days[0].date,end:days.at(-1).date,days};
 const original=historyChart(history,'calories',{asOf:'2026-10-11',maintenance:2400});
 const enhanced=historyChart(history,'calories',{asOf:'2026-10-23',maintenance:2400});
 const stripped=enhanced.replace(/<path d="[^"]*" class="chart-week-progress(?: chart-week-provisional)?"><title>[^<]*<\/title><\/path>/g,'').replace(/<circle[^>]*class="chart-week-progress-point"\/>/,'');
 assert.equal(stripped,original);
 assert.equal((enhanced.match(/<figure/g)||[]).length,1);
 assert.doesNotMatch(historyChart(history,'protein',{asOf:'2026-10-23',maintenance:2400}),/chart-week-progress/);
});

test('Sunday is a point, Monday connects two days, and no weekly line can exceed seven days',()=>{
 const history={start:days[0].date,end:days.at(-1).date,days};
 for(const[date,count,point]of[['2026-10-18',0,true],['2026-10-19',1,false],['2026-10-24',6,false]]){
  const chart=historyChart(history,'calories',{asOf:date,maintenance:2400});
  const paths=[...chart.matchAll(/<path d="([^"]*)" class="chart-week-progress(?: chart-week-provisional)?"/g)].map(match=>match[1]).join(' ');
  assert.equal((paths.match(/C/g)||[]).length,count);
  assert.equal(chart.includes('class="chart-week-progress-point"'),point);
 }
 assert.equal(currentWeekProgress(days.slice(2),'2026-10-23',2400).size,0);
});

test('eating maintenance stays on the green line every day, including Friday instead of falsely indicating a deficit',()=>{
 const balanced=days.slice(1).map(d=>({...d,actual:{calories:2400}}));
 const points=currentWeekProgress(balanced,'2026-10-23',2400);
 for(const point of points.values()){assert.equal(point.ratio,1);assert.equal(point.balance,0);assert.equal(point.value,2400);}
 assert.equal(points.get('2026-10-23').maintenance,6*2400);
 assert.equal(points.get('2026-10-23').provisional,true);
 assert.equal(points.get('2026-10-22').provisional,false);
});

test('following changing daily goals coincides with the grey line, while surplus remains above maintenance',()=>{
 for(const targets of [[1800,1700,1600,1500,1400,1300,1300],[2800,2900,3000,3100,3200,3300,3300]]){
  const onGoal=days.slice(1).map((d,i)=>({...d,target:{calories:targets[i]},actual:{calories:targets[i]}}));
  const progress=currentWeekProgress(onGoal,'2026-10-23',2400);
  for(let i=0;i<6;i++)assert.ok(Math.abs(progress.get(onGoal[i].date).value-targets[i])<1e-8);
 }
 const over=days.slice(1).map(d=>({...d,actual:{calories:2600}}));
 for(const point of currentWeekProgress(over,'2026-10-23',2400).values()){assert.ok(point.value>2400);assert.ok(point.balance>0);}
});

test('missing registrations do not become zero-calorie deficit days',()=>{
 const incomplete=days.slice(1).map((d,i)=>({...d,actual:{calories:i===0?null:2400}}));
 const points=currentWeekProgress(incomplete,'2026-10-23',2400);
 assert.equal(points.has('2026-10-18'),false);
 const last=points.get('2026-10-23');assert.equal(last.missingDays,1);assert.equal(last.balance,0);assert.equal(last.value,2400);
 assert.equal(last.maintenance,5*2400);
 const chart=historyChart({start:incomplete[0].date,end:incomplete.at(-1).date,days:incomplete},'calories',{asOf:'2026-10-23',maintenance:2400});
 assert.match(chart,/Hoy: provisional/);assert.match(chart,/Faltan registros de 1 día/);assert.doesNotMatch(chart,/chart-week-provisional/);
});

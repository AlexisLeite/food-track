import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothChartPath } from '../public/chart-path.js';

test('smooth curves preserve data points without overshooting peaks or valleys',()=>{
 const points=[{x:0,y:8},{x:10,y:0},{x:20,y:7},{x:30,y:3},{x:40,y:9}];
 const path=smoothChartPath(points);assert.ok(path.startsWith('M0.0,8.0'));
 const segments=path.split(' C').slice(1);assert.equal(segments.length,points.length-1);
 for(let i=0;i<segments.length;i++){
  const values=segments[i].match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.deepEqual(values.slice(-2),[points[i+1].x,points[i+1].y]);
  const [controlX1,controlY1,controlX2,controlY2,endX,endY]=values;
  assert.ok(controlX1>points[i].x && controlX2<endX);
  for(let n=0;n<=100;n++){
   const t=n/100,u=1-t;
   const y=u*u*u*points[i].y+3*u*u*t*controlY1+3*u*t*t*controlY2+t*t*t*endY;
   assert.ok(y>=Math.min(points[i].y,endY)-.001 && y<=Math.max(points[i].y,endY)+.001);
  }
 }
});

test('missing days split curves instead of inventing connections',()=>{
 const path=smoothChartPath([{x:0,y:1},{x:1,y:2},null,{x:3,y:4},{x:4,y:5}]);
 assert.equal((path.match(/M/g)||[]).length,2);assert.equal((path.match(/C/g)||[]).length,2);
 assert.equal(smoothChartPath([null]),'');assert.equal(smoothChartPath([{x:1,y:2}]),'M1.0,2.0');
});

test('flat reference lines remain flat when represented as smooth curves',()=>{
 const path=smoothChartPath([{x:0,y:10},{x:5,y:10},{x:10,y:10}]);
 const ys=[...path.matchAll(/,(-?\d+(?:\.\d+)?)/g)].map(match=>Number(match[1]));
 assert.ok(ys.every(y=>y===10));assert.equal((path.match(/C/g)||[]).length,2);
});

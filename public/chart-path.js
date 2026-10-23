const point = (x,y) => `${x.toFixed(1)},${y.toFixed(1)}`;
function segmentPath(points) {
  if (!points.length) return '';
  let path = `M${point(points[0].x,points[0].y)}`;
  if (points.length === 1) return path;
  const gaps = points.slice(1).map((p,i)=>p.x-points[i].x);
  const slopes = gaps.map((gap,i)=>(points[i+1].y-points[i].y)/gap);
  const tangents = new Array(points.length);
  const endpoint = (h0,h1,d0,d1) => {
    const tangent=((2*h0+h1)*d0-h0*d1)/(h0+h1);
    if (Math.sign(tangent)!==Math.sign(d0)) return 0;
    return Math.sign(d0)!==Math.sign(d1) && Math.abs(tangent)>3*Math.abs(d0) ? 3*d0 : tangent;
  };
  if (points.length===2) tangents.fill(slopes[0]);
  else {
    tangents[0]=endpoint(gaps[0],gaps[1],slopes[0],slopes[1]);
    const last=slopes.length-1;
    tangents[points.length-1]=endpoint(gaps[last],gaps[last-1],slopes[last],slopes[last-1]);
    for(let i=1;i<points.length-1;i++) {
      if(slopes[i-1]*slopes[i]<=0) tangents[i]=0;
      else {
        const w1=2*gaps[i]+gaps[i-1],w2=gaps[i]+2*gaps[i-1];
        tangents[i]=(w1+w2)/(w1/slopes[i-1]+w2/slopes[i]);
      }
    }
  }
  for(let i=0;i<points.length-1;i++) {
    const from=points[i],to=points[i+1],third=gaps[i]/3;
    path+=` C${point(from.x+third,from.y+tangents[i]*third)} ${point(to.x-third,to.y-tangents[i+1]*third)} ${point(to.x,to.y)}`;
  }
  return path;
}
// Shape-preserving cubic interpolation, split at missing data rather than bridging gaps.
export function smoothChartPath(points) {
  const parts=[];let current=[];
  for(const value of [...points,null]) {
    if(value && Number.isFinite(value.x) && Number.isFinite(value.y)) current.push(value);
    else {if(current.length) parts.push(segmentPath(current));current=[];}
  }
  return parts.join(' ');
}

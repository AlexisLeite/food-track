import { smoothChartPath } from './chart-path.js?v=20261023-smooth-lines-1';
import { currentWeekProgress } from './week-progress.js?v=20261023-smooth-lines-1';
const fmt = value => new Intl.NumberFormat('es-UY', { maximumFractionDigits: 1 }).format(value);
const shortDate = date => new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));
const labels = { calories: 'Calorías', protein: 'Proteínas', fat: 'Grasas', carbs: 'Carbohidratos' };
export function historyChart(history, metric, { asOf = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()), maintenance } = {}) {
  const days = history.days;
  const showMaintenance = metric === 'calories' && days.some(day => Number.isFinite(day.maintenance?.calories));
  const sources = showMaintenance ? ['maintenance', 'target', 'actual'] : ['target', 'actual'];
  const sourceLabels = { actual: 'Consumido', target: 'Objetivo', maintenance: 'Mantenimiento' };
  const unit = metric === 'calories' ? 'kcal' : 'g';
  const width = 420, height = 240, left = 46, right = 14, top = 18, bottom = 36;
  const values = days.flatMap(d => sources.map(source => d[source]?.[metric])).filter(v => typeof v === 'number');
  const roughStep = Math.max(1, ...values) / 4;
  const power = 10 ** Math.floor(Math.log10(roughStep));
  const step = Math.ceil(roughStep / power) * power, max = step * 4;
  const x = i => left + i * (width - left - right) / Math.max(1, days.length - 1);
  const y = value => top + (1 - value / max) * (height - top - bottom);
  const weekly = metric === 'calories' ? currentWeekProgress(days,asOf,maintenance) : new Map();
  const weeklyPoints = days.map((day,index)=>({index,...weekly.get(day.date)})).filter(point=>Number.isFinite(point.value));
  const weeklyPath=smoothChartPath(days.map((day,index)=>{
    const value=weekly.get(day.date)?.value;
    return Number.isFinite(value)?{x:x(index),y:y(value)}:null;
  }));
  const weeklyLast=weeklyPoints.at(-1);
  const weeklyDescription=weeklyLast ? `Semana actual: balance registrado ${fmt(weeklyLast.balance)} kcal; diferencia con el objetivo ${fmt(weeklyLast.goalDifference)} kcal${weeklyLast.provisional?'. Hoy: provisional, día incompleto':''}${weeklyLast.missingDays?`. Faltan registros de ${weeklyLast.missingDays} día(s)`:''}${weeklyLast.pendingDays?'. Hay comidas sin confirmar':''}` : '';
  const weeklyOverlay=weeklyLast ? `<path d="${weeklyPath}" class="chart-week-progress"><title>${weeklyDescription}</title></path>${weeklyPoints.length===1?`<circle cx="${x(weeklyLast.index)}" cy="${y(weeklyLast.value)}" r="2.5" class="chart-week-progress-point"/>`:''}` : '';
  const line = source => smoothChartPath(days.map((day,index)=>{
    const value=day[source]?.[metric];
    return Number.isFinite(value)?{x:x(index),y:y(value)}:null;
  }));
  const grid = Array.from({ length: 5 }, (_, i) => { const value = step * i; return `<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end">${fmt(value)}</text>`; }).join('');
  const ticks = [...new Set([0, Math.floor((days.length-1)/2), days.length-1])].map(i => `<text x="${x(i)}" y="${height-10}" text-anchor="${i === 0 ? 'start' : i === days.length-1 ? 'end' : 'middle'}">${shortDate(days[i].date)}</text>`).join('');
  const points = metric === 'calories' ? '' : days.map((day, i) => ['actual'].map(source => {
    const value = day[source]?.[metric]; if (typeof value !== 'number') return '';
    return `<circle cx="${x(i)}" cy="${y(value)}" r="2" class="chart-point-${source}"><title>${shortDate(day.date)}: ${sourceLabels[source]} ${fmt(value)} ${unit}</title></circle>`;
  }).join('')).join('');
  return `<figure class="history-chart"><figcaption>${labels[metric]} <span class="muted">(${unit})</span></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${labels[metric]} consumidos, objetivo diario${showMaintenance ? ' y mantenimiento' : ''} del ${shortDate(history.start)} al ${shortDate(history.end)}"><title>Consumo y objetivo diario${showMaintenance ? ' y mantenimiento del peso' : ''}</title>${grid}${ticks}${showMaintenance ? `<path d="${line('maintenance')}" class="chart-maintenance"/>` : ''}<path d="${line('target')}" class="chart-target"/>${metric === 'calories' ? '' : `<path d="${line('actual')}" class="chart-actual"/>`}${points}${weeklyOverlay}</svg><div class="chart-legend">${metric === 'calories' ? '<span><i class="legend-week-progress"></i>Balance semanal</span>' : '<span><i class="legend-actual"></i>Consumido</span>'}<span><i class="legend-target"></i>Objetivo</span>${showMaintenance ? '<span><i class="legend-maintenance"></i>Mantenimiento</span>' : ''}</div></figure>${days.some(d => typeof d.actual[metric] === 'number') ? '' : '<p class="empty">Todavía no hay registros para este período.</p>'}<p class="hint">Los días sin registro no cuentan como consumo cero. El porcentaje indica cuánto consumiste del objetivo.</p><details class="history-data"><summary>Ver por día</summary><div class="history-table-wrap"><table><thead><tr><th>Día</th><th>Consumido</th><th>Objetivo</th><th>%</th></tr></thead><tbody>${days.slice().reverse().map(day => {
    const actual = day.actual[metric], target = day.target?.[metric];
    return `<tr><td><button class="text" data-history-date="${day.date}" aria-label="Ver comida del ${day.date}">${shortDate(day.date)}</button></td><td>${typeof actual === 'number' ? `${fmt(actual)} ${unit}` : day.meals ? 'Sin macros' : 'Sin registro'}${day.pendingMeals ? `<small>${day.pendingMeals} sin confirmar</small>` : ''}</td><td>${typeof target === 'number' ? `${fmt(target)} ${unit}` : 'Sin objetivo'}</td><td>${typeof actual === 'number' && target > 0 ? fmt(actual / target * 100) + '%' : '—'}</td></tr>`;
  }).join('')}</tbody></table></div></details>`;
}

const fmt = value => new Intl.NumberFormat('es-UY', { maximumFractionDigits: 1 }).format(value);
const shortDate = date => new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));
const labels = { calories: 'Calorías', protein: 'Proteínas', fat: 'Grasas', carbs: 'Carbohidratos' };
export function historyChart(history, metric) {
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
  const line = source => {
    let active = false;
    return days.map((day, i) => {
      const value = day[source]?.[metric];
      if (typeof value !== 'number') { active = false; return ''; }
      const point = `${active ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)}`; active = true; return point;
    }).join(' ');
  };
  const grid = Array.from({ length: 5 }, (_, i) => { const value = step * i; return `<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end">${fmt(value)}</text>`; }).join('');
  const ticks = [...new Set([0, Math.floor((days.length-1)/2), days.length-1])].map(i => `<text x="${x(i)}" y="${height-10}" text-anchor="${i === 0 ? 'start' : i === days.length-1 ? 'end' : 'middle'}">${shortDate(days[i].date)}</text>`).join('');
  const points = days.map((day, i) => ['actual'].map(source => {
    const value = day[source]?.[metric]; if (typeof value !== 'number') return '';
    return `<circle cx="${x(i)}" cy="${y(value)}" r="${source === 'actual' ? 3.5 : 2.5}" class="chart-point-${source}"><title>${shortDate(day.date)}: ${sourceLabels[source]} ${fmt(value)} ${unit}</title></circle>`;
  }).join('')).join('');
  return `<figure class="history-chart"><figcaption>${labels[metric]} <span class="muted">(${unit})</span></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${labels[metric]} consumidos, objetivo diario${showMaintenance ? ' y mantenimiento' : ''} del ${shortDate(history.start)} al ${shortDate(history.end)}"><title>Consumo y objetivo diario${showMaintenance ? ' y mantenimiento del peso' : ''}</title>${grid}${ticks}${showMaintenance ? `<path d="${line('maintenance')}" class="chart-maintenance"/>` : ''}<path d="${line('target')}" class="chart-target"/><path d="${line('actual')}" class="chart-actual"/>${points}</svg><div class="chart-legend"><span><i class="legend-actual"></i>Consumido</span><span><i class="legend-target"></i>Objetivo</span>${showMaintenance ? '<span><i class="legend-maintenance"></i>Mantenimiento</span>' : ''}</div></figure>${days.some(d => typeof d.actual[metric] === 'number') ? '' : '<p class="empty">Todavía no hay registros para este período.</p>'}<p class="hint">Los días sin registro no cuentan como consumo cero. El porcentaje indica cuánto consumiste del objetivo.</p><details class="history-data"><summary>Ver por día</summary><div class="history-table-wrap"><table><thead><tr><th>Día</th><th>Consumido</th><th>Objetivo</th><th>%</th></tr></thead><tbody>${days.slice().reverse().map(day => {
    const actual = day.actual[metric], target = day.target?.[metric];
    return `<tr><td><button class="text" data-history-date="${day.date}" aria-label="Ver comida del ${day.date}">${shortDate(day.date)}</button></td><td>${typeof actual === 'number' ? `${fmt(actual)} ${unit}` : day.meals ? 'Sin macros' : 'Sin registro'}${day.pendingMeals ? `<small>${day.pendingMeals} sin confirmar</small>` : ''}</td><td>${typeof target === 'number' ? `${fmt(target)} ${unit}` : 'Sin objetivo'}</td><td>${typeof actual === 'number' && target > 0 ? fmt(actual / target * 100) + '%' : '—'}</td></tr>`;
  }).join('')}</tbody></table></div></details>`;
}

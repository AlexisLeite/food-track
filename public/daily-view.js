const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function dateSelectorMarkup({ date, today, id, max }) {
  const formatted = new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
  const arrow = path => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  return `<div class="date-nav"><button class="icon" data-action="prev" aria-label="Día anterior">${arrow('m15 6-6 6 6 6')}</button><label class="date-field"><span>${esc(date === today ? `Hoy, ${formatted}` : formatted)}</span><input id="${esc(id)}" type="date" value="${esc(date)}" ${max ? `max="${esc(max)}"` : ''} aria-label="Seleccionar fecha"></label><button class="icon" data-action="next" aria-label="Día siguiente" ${max && date >= max ? 'disabled' : ''}>${arrow('m9 6 6 6-6 6')}</button></div>`;
}

export function dailyRecordMarkup({ kind, id, name, details = [], calories, photoUrl, icon = '≡' }) {
  return `<button class="meal" data-${kind}="${esc(id)}">${photoUrl ? `<img src="${esc(photoUrl)}" alt="" loading="lazy">` : `<span class="text-meal-icon" aria-hidden="true">${icon}</span>`}<span class="name"><strong>${esc(name)}</strong>${details.map(detail => `<small>${esc(detail)}</small>`).join('')}</span><span class="kcal">${Number.isFinite(calories) ? `${new Intl.NumberFormat('es-UY').format(calories)} kcal` : '…'}</span></button>`;
}

const monthLabel = new Intl.DateTimeFormat('es-UY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const iso = date => date.toISOString().slice(0, 10);

// Render inside the dialog so mobile browsers never put a native picker behind it.
export function bindRepeatCalendar(container, { date, onSelect }) {
  let month = new Date(`${date}T12:00:00Z`);
  month.setUTCDate(1);
  function render() {
    const offset = month.getUTCDay();
    const count = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    container.innerHTML = `<div class="repeat-calendar-head"><button type="button" data-month="-1" aria-label="Mes anterior">‹</button><span aria-live="polite">${monthLabel.format(month)}</span><button type="button" data-month="1" aria-label="Mes siguiente">›</button></div><div class="repeat-calendar-grid">${['Do','Lu','Ma','Mi','Ju','Vi','Sá'].map(day => `<span class="muted" aria-hidden="true">${day}</span>`).join('')}${'<span aria-hidden="true"></span>'.repeat(offset)}${Array.from({ length: count }, (_, i) => {
      const value = new Date(month); value.setUTCDate(i + 1);
      return `<button type="button" data-repeat-date="${iso(value)}" aria-label="Repetir el ${dayLabel.format(value)}"${iso(value) === date ? ' aria-current="date"' : ''}>${i + 1}</button>`;
    }).join('')}</div>`;
  }
  container.onclick = event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !container.contains(button)) return;
    if (button.dataset.month) {
      const direction = Number(button.dataset.month);
      month.setUTCMonth(month.getUTCMonth() + direction); render();
      container.querySelector(`[data-month="${direction}"]`).focus();
    } else if (button.dataset.repeatDate) onSelect(button.dataset.repeatDate);
  };
  render();
}

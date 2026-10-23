const fmt = value => new Intl.NumberFormat('es-UY').format(value);
let sequence = 0;
export function calorieProgressMarkup({ total, target, maintenance, unavailable = false }) {
  if (unavailable) return '<div class="calorie-progress unavailable" aria-hidden="true"><div class="calorie-track"></div></div>';
  const showMaintenance = total > target && Number.isFinite(maintenance) && maintenance > 0;
  const maximum = Math.max(total, target, showMaintenance ? maintenance : 0, 1);
  const position = value => Math.min(100, Math.max(0, value / maximum * 100));
  const consumed = position(total), goal = position(target);
  const maintenancePosition = showMaintenance ? position(maintenance) : goal;
  const gradientEnd = Math.max(goal, maintenancePosition);
  const gradientWidth = Math.max(0, Math.min(consumed, gradientEnd) - goal);
  const overflowWidth = Math.max(0, consumed - gradientEnd);
  const gradientId = `calorie-gradient-${++sequence}`;
  const arrow = (value, label, className) => `<path class="calorie-goal ${className}" d="M${position(value) - 1.4} 0h2.8L${position(value)} 4z"><title>${label}: ${fmt(value)} kcal</title></path>`;
  return `<div class="calorie-progress"><svg class="calorie-meter" viewBox="-1 0 102 8" preserveAspectRatio="none" role="meter" aria-label="Calorías consumidas" aria-valuemin="0" aria-valuemax="${maximum}" aria-valuenow="${total}" aria-valuetext="${fmt(total)} kcal consumidas; objetivo ${fmt(target)} kcal${showMaintenance ? `; mantenimiento ${fmt(maintenance)} kcal` : ''}"><defs><linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${goal}" y1="0" x2="${gradientEnd}" y2="0"><stop offset="0" stop-color="#227444"/><stop offset="1" stop-color="#b32c2c"/></linearGradient></defs><rect class="calorie-track" x="0" y="5" width="100" height="2" rx="1"/><rect class="calorie-fill" x="0" y="5" width="${Math.min(consumed, goal)}" height="2" rx="${total > target ? 0 : 1}"/>${gradientWidth > 0 ? `<rect class="calorie-gradient" x="${goal}" y="5" width="${gradientWidth}" height="2" fill="url(#${gradientId})"/>` : ''}${overflowWidth > 0 ? `<rect class="calorie-overflow" x="${gradientEnd}" y="5" width="${overflowWidth}" height="2"/>` : ''}${arrow(target, 'Objetivo', 'calorie-goal-target')}${showMaintenance ? arrow(maintenance, 'Mantenimiento', 'calorie-goal-maintenance') : ''}</svg></div>`;
}

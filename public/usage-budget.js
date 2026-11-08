export function usageBudgetMarkup({ budgets, timeZone }, authorized = true) {
  const renewal = value => new Intl.DateTimeFormat('es-UY', { timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  const row = (kind, label) => {
    const { remaining, limit } = budgets[kind];
    return `<div class="usage-budget-row"><dt>${label}</dt><dd${remaining === 0 ? ' class="usage-exhausted"' : ''} aria-label="${remaining} restantes de ${limit}">${remaining} <span>/ ${limit}</span></dd></div>`;
  };
  return `<h2>Presupuesto disponible</h2>${authorized ? '' : '<p class="hint">El uso de IA no está habilitado para tu usuario. Contactá con el administrador.</p>'}<p class="usage-budget-caption">Restantes / total</p><dl>${row('food', 'Comidas')}${row('workout', 'Entrenamientos')}${row('clarification', 'Aclaraciones')}</dl><p class="usage-budget-renewal">Se renueva el ${renewal(budgets.food.renewsAt)} · Uruguay</p><small>Las aclaraciones se comparten entre comidas y entrenamientos.</small><dl class="usage-chat-budget">${row('chat', 'Chat')}</dl><p class="usage-budget-renewal">Se renueva el ${renewal(budgets.chat.renewsAt)} · Uruguay</p>`;
}

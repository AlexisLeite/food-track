const icon = content => `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
const sources = {
  audio: icon('<rect x="12" y="3" width="8" height="16" rx="4"/><path d="M7 14v2a9 9 0 0 0 18 0v-2M16 25v4M11 29h10"/>'),
  text: icon('<path d="M8 3h12l5 5v21H7V3h1M19 3v7h6M12 15h8M12 20h8M12 25h4"/>'),
  photo: icon('<path d="M4 9h6l2-4h8l2 4h6v18H4z"/><circle cx="16" cy="18" r="6"/>')
};
const plate = icon('<circle cx="17" cy="16" r="9"/><path d="M3 3v8M7 3v8M3 8h4M5 11v18M29 3v26"/>');
const data = icon('<path d="M5 4v24h23M11 21v-6M18 21V8M25 21V4"/>');
export function processingMarkup(source = 'text', message = 'Analizando comida…') {
  return `<div class="processing-state" role="status" aria-live="polite"><div class="processing-icons" aria-hidden="true"><span class="processing-icon">${sources[source] || sources.text}</span><span class="processing-link"></span><span class="processing-icon">${plate}</span><span class="processing-link"></span><span class="processing-icon">${data}</span></div><p>${message}</p></div>`;
}
export function showProcessing(form, source = 'text', message = 'Analizando comida…') {
  form.dataset.processing = 'true'; form.dataset.processingSource = source;
  let status = form.querySelector('.processing-state');
  if (!status) { form.insertAdjacentHTML('beforeend', processingMarkup(source, message)); }
  else status.querySelector('p').textContent = message;
}
export function hideProcessing(form) {
  delete form.dataset.processing; delete form.dataset.processingSource;
  form.querySelector('.processing-state')?.remove();
}

import { calorieProgressMarkup } from './calorie-progress.js?v=20261023-maintenance-bar-1';
import './dock-offset.js?v=20261023-safari-offset-16';
import { bindDaySwipe } from './swipe.js?v=20261023-day-swipe-1';
import { readApiResponse } from './api-response.js?v=20261023-audio-errors-1';
import { processingMarkup, showProcessing } from './processing.js';
import { getMacroPlan, getGoalProjection, getCalorieLimits, hasMacros, summarizeMeals } from './nutrition.js?v=20261019-deficit-1200-1';
import { historyChart } from './history.js?v=20261023-red-only-1';
import { createVoiceInput } from './voice.js?v=20261019-repeat-meal-2';
import { createUserCache, isCancelledError } from './cache.js?v=20261020-week-allocation-1';
const root = document.querySelector('#app');
const dock = document.querySelector('#app-dock');
function syncDock() {
  const navigation = root.querySelector('.bottom-nav');
  const dateSelector = root.querySelector('.date-nav');
  dock.replaceChildren(...[dateSelector, navigation].filter(Boolean));
  dock.hidden = !navigation;
}
const dialog = document.querySelector('#meal-dialog');
const notice = document.querySelector('#notice');
const sectionCache = createUserCache();
window.addEventListener('pagehide', () => sectionCache.persist());
// Safari anterior a 15.4 no implementa el elemento dialog.
if (typeof dialog.showModal !== 'function') {
  Object.defineProperty(dialog, 'open', { get: () => dialog.hasAttribute('open') });
  dialog.showModal = () => { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); };
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); };
}

let modalMotion = null, modalGeneration = 0;
function showModal() {
  const reopening = dialog.classList.contains('closing');
  if (dialog.open && !reopening) return;
  ++modalGeneration; modalMotion?.cancel(); dialog.classList.remove('closing');
  dialog.classList.remove('opening');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  if (!dialog.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  dialog.classList.add('opening');
  modalMotion = dialog.animate([{ opacity: 0, transform: 'translateY(14px) scale(.98)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 180, easing: 'ease-out' });
  const motion = modalMotion;
  motion.finished.then(() => { if (modalMotion === motion) dialog.classList.remove('opening'); }).catch(() => {});
}
async function closeModal() {
  voice.cancel({ restore: false });
  if (!dialog.open || dialog.classList.contains('closing')) return;
  const generation = ++modalGeneration; modalMotion?.cancel(); dialog.classList.remove('opening');
  if (dialog.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.classList.add('closing');
    modalMotion = dialog.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(10px) scale(.98)' }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
    await modalMotion.finished.catch(() => {});
  }
  if (generation !== modalGeneration) return;
  dialog.close(); modalMotion?.cancel(); modalMotion = null; dialog.classList.remove('closing');
}
dialog.addEventListener('cancel', event => { event.preventDefault(); closeModal(); });

let user = null, meals = [], currentDate = localDate(), view = 'day', authMode = 'login';
let activeMeal = null, analysisBusy = false, loadingDay = false, uploading = false;
let noticeTimer, dayRequest = 0;
let audioBusy = false, analysisSource = 'text';
const voice = createVoiceInput({ api, toast, onBusyChange: value => { audioBusy = value; } });
let navigationRequest = 0, pendingDate = null, transitionAnimations = [];
let week = null;
let loadedDate = null, dayError = '', historyError = '', historyLoading = false;
let historyData = null, historyRange = 7, historyEnd = localDate(), historyMetric = 'calories', historyRequest = 0;
function localDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const fmt = value => new Intl.NumberFormat('es-UY').format(value);
function toast(message, error = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message; notice.classList.toggle('error-notice', error);
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.setAttribute('aria-live', error ? 'assertive' : 'polite');
  notice.style.setProperty('--toast-bottom', `${dock.hidden ? 16 : dock.getBoundingClientRect().height + 12}px`);
  notice.hidden = false;
  // A popover remains above modal dialogs; z-index alone cannot cross the top layer.
  if (notice.showPopover && !notice.matches(':popover-open')) notice.showPopover();
  noticeTimer = setTimeout(() => {
    if (notice.hidePopover && notice.matches(':popover-open')) notice.hidePopover();
    notice.hidden = true;
  }, error ? 8000 : 3500);
}
async function requestApi(url, options = {}) {
  const { known, includeRevision, ...requestOptions } = options; options = requestOptions;
  const headers = { 'X-Foodtrack': '1', ...options.headers };
  if (known?.etag) headers['If-None-Match'] = known.etag;
  if (options.body && !(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  let res;
  try { res = await fetch(url, { ...options, headers }); } catch { throw new Error('No hay conexión. Volvé a intentarlo.'); }
  if (res.status === 304 && known) return { data: known.data, etag: known.etag };
  let data;
  try { data = await readApiResponse(res); }
  catch (error) {
    if (error.code === 'INVALID_API_RESPONSE') console.warn('api_response_error', { path: url, method: options.method || 'GET', status: res.status, contentType: res.headers.get('Content-Type'), requestId: res.headers.get('X-Request-ID'), proxyRequestId: res.headers.get('CF-Ray') });
    throw error;
  }
  if (!res.ok) { if (res.status === 401 && user) { sectionCache.clear(true); user = null; meals = []; week = null; closeModal(); render(); } throw Object.assign(new Error(data.error || 'No se pudo completar la acción.'), { status: res.status, code: data.code }); }
  return includeRevision ? { data, etag: res.headers.get('ETag') } : data;
}
async function api(url, options = {}) {
  const method = options.method || 'GET';
  const cached = method === 'GET' && user && (url.startsWith('/api/day?') || url.startsWith('/api/history?'));
  if (cached) {
    const identity = user.id;
    const load = ({ signal, known }) => requestApi(url, { ...options, signal, known, includeRevision: true });
    try { return await sectionCache.fetch(url, load); }
    catch (error) {
      if (isCancelledError(error) && user?.id === identity) return sectionCache.fetch(url, load);
      throw error;
    }
  }
  const data = await requestApi(url, options);
  if (data.user && ['/api/me', '/api/login', '/api/register'].includes(url)) { sectionCache.setUser(data.user.id); sectionCache.setProfile(data.user.profile); }
  if (method !== 'GET' && url === '/api/profile') { sectionCache.invalidate(); sectionCache.setProfile(data.profile); historyData = null; week = null; }
  if (method !== 'GET' && url.startsWith('/api/meals')) {
    sectionCache.invalidate('day');
    sectionCache.invalidate('history'); historyData = null;
  }
  if (url === '/api/logout') sectionCache.clear(true);
  return data;
}

function header(title = 'Comida') {
  const icons = {
    day: '<path d="M5 3v6a3 3 0 0 0 6 0V3M8 3v18M18 3c-2 3-3 6-3 9h5M20 3v18"/>',
    history: '<path d="M4 3v17h17M8 14l4-5 4 3 5-7"/>',
    settings: '<path d="M4 7h7M15 7h5M4 17h2M10 17h10"/><circle cx="13" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'
  };
  return `<header class="app-header"><h1 class="sr-only">${title}</h1><nav class="bottom-nav" aria-label="Secciones">${[['day', 'Comida'], ['history', 'Historia'], ['settings', 'Configuración']].map(([section, label]) => `<button type="button" class="bottom-nav-button" data-action="${section}" aria-label="${label}" title="${label}" ${view === section ? 'aria-current="page"' : ''} ${!user.profile && section !== 'settings' ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[section]}</svg></button>`).join('')}</nav></header>`;
}
function footer() { return `<footer class="footer"><small>${esc(user.username)}</small><button class="text" data-action="logout">Salir</button></footer>`; }
function snapshotPanel(selector = '.view-panel') {
  for (const animation of transitionAnimations) animation.cancel();
  transitionAnimations = [];
  root.querySelectorAll('.view-snapshot').forEach(node => node.remove());
  root.classList.remove('transitioning');
  const source = root.querySelector(selector);
  if (!source) return null;
  const snapshot = source.cloneNode(true);
  snapshot.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  snapshot.querySelectorAll('button,input,select,textarea').forEach(node => { node.disabled = true; node.tabIndex = -1; });
  snapshot.setAttribute('aria-hidden', 'true'); snapshot.inert = true;
  return snapshot;
}
function animatePanel(snapshot, direction, selector = '.view-panel') {
  const panel = root.querySelector(selector);
  if (!snapshot || !panel?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  snapshot.classList.add('view-snapshot');
  const rect = panel.getBoundingClientRect(), origin = root.getBoundingClientRect();
  snapshot.style.top = `${rect.top - origin.top + root.scrollTop}px`; snapshot.style.left = `${rect.left - origin.left + root.scrollLeft}px`; snapshot.style.width = `${rect.width}px`;
  root.append(snapshot); root.classList.add('transitioning');
  const options = { duration: 260, easing: 'cubic-bezier(.22,.61,.36,1)' };
  const outgoing = snapshot.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-direction*100}%)`, opacity: 0 }], options);
  const incoming = panel.animate([{ transform: `translateX(${direction*100}%)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], options);
  transitionAnimations = [outgoing, incoming];
  return Promise.allSettled(transitionAnimations.map(a => a.finished)).then(() => { snapshot.remove(); if (transitionAnimations[0] === outgoing) { transitionAnimations = []; root.classList.remove('transitioning'); } });
}
async function switchView(next, date = currentDate) {
  if (!user?.profile && next !== 'settings') return;
  const request = ++navigationRequest; ++dayRequest; pendingDate = null;
  const historyLoadRequest = next === 'history' ? ++historyRequest : null;
  const identity = user.id, previous = view, snapshot = snapshotPanel();
  if (next === 'day') {
    const cached = sectionCache.peek(`/api/day?date=${date}`);
    if (cached) { meals = cached.meals; week = cached.week || null; loadedDate = date; }
    else if (loadedDate !== date) { meals = []; week = null; }
    currentDate = date; loadingDay = loadedDate !== date; dayError = '';
  }
  if (next === 'history') { historyData = sectionCache.peek(`/api/history?days=${historyRange}&end=${historyEnd}`) || null; historyLoading = true; historyError = ''; }
  view = next; render();
  const order = ['day', 'history', 'settings'];
  const motion = previous !== next ? animatePanel(snapshot, order.indexOf(next) > order.indexOf(previous) ? 1 : -1) : Promise.resolve();
  if (next === 'settings') return;
  root.setAttribute('aria-busy', 'true');
  try {
    const [data] = await Promise.all([api(next === 'day' ? `/api/day?date=${date}` : `/api/history?days=${historyRange}&end=${historyEnd}`), motion]);
    if (request !== navigationRequest || user?.id !== identity || (next === 'history' && historyLoadRequest !== historyRequest)) return;
    if (next === 'day') { meals = data.meals; week = data.week || null; loadedDate = date; loadingDay = false; }
    else { historyData = data; historyLoading = false; }
    render();
  } catch (error) {
    await motion;
    if (request !== navigationRequest || user?.id !== identity) return;
    if (next === 'day') { loadingDay = false; if (loadedDate !== date) dayError = error.message; }
    else { historyLoading = false; historyError = error.message; }
    render(); toast(error.message, true);
  } finally { if (request === navigationRequest) root.setAttribute('aria-busy', 'false'); }
}
async function changeDay(date, force = false) {
  if (!date || (date === currentDate && !pendingDate && !force)) return;
  const request = ++navigationRequest; ++dayRequest; pendingDate = date;
  const identity = user?.id, previous = currentDate, snapshot = snapshotPanel('.day-panel');
  const cached = sectionCache.peek(`/api/day?date=${date}`);
  currentDate = date; meals = cached?.meals || []; week = cached?.week || null; loadingDay = !cached; dayError = ''; render();
  const motion = previous !== date ? animatePanel(snapshot, date > previous ? 1 : -1, '.day-panel') : Promise.resolve();
  root.setAttribute('aria-busy', 'true');
  try {
    const [data] = await Promise.all([api(`/api/day?date=${date}`), motion]);
    if (request !== navigationRequest || view !== 'day' || user?.id !== identity) return;
    meals = data.meals; week = data.week || null; loadedDate = date; loadingDay = false; render();
  } catch (error) {
    await motion;
    if (request !== navigationRequest || view !== 'day' || user?.id !== identity) return;
    loadingDay = false; if (!cached) dayError = error.message; render(); toast(error.message, true);
  } finally { if (request === navigationRequest) { pendingDate = null; root.setAttribute('aria-busy', 'false'); } }
}

function renderHistory() {
  root.innerHTML = `${header('Historia')}<div class="view-panel"><section aria-label="Historia de consumo"><div class="history-controls"><div><label for="history-metric">Mostrar</label><select id="history-metric">${[['calories', 'Calorías'], ['protein', 'Proteínas'], ['fat', 'Grasas'], ['carbs', 'Carbohidratos']].map(([key, label]) => `<option value="${key}" ${historyMetric === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div><label for="history-range">Período</label><select id="history-range">${[7,30,90].map(n => `<option value="${n}" ${historyRange === n ? 'selected' : ''}>${n} días</option>`).join('')}</select></div><div class="history-end"><label for="history-end">Hasta</label><input type="date" id="history-end" value="${historyEnd}"></div></div>${historyData ? historyChart(historyData, historyMetric, { asOf: localDate(), maintenance: user.profile.expenditure }) : historyError ? `<p class="error">${esc(historyError)}</p><button class="text" data-action="history">Reintentar</button>` : '<p class="empty history-loading" role="status">Cargando historia…</p>'}</section>${footer()}</div>`;
  syncDock();
  document.querySelector('#history-metric').onchange = e => { historyMetric = e.target.value; renderHistory(); };
  for (const id of ['history-range', 'history-end']) document.getElementById(id).onchange = async () => {
    const days = Number(document.querySelector('#history-range').value), end = document.querySelector('#history-end').value;
    if (!end) return;
    const request = ++historyRequest; const identity = user?.id;
    try {
      const data = await api(`/api/history?days=${days}&end=${end}`);
      if (request !== historyRequest || view !== 'history' || user?.id !== identity) return;
      historyData = data; historyRange = days; historyEnd = end; historyLoading = false; historyError = ''; renderHistory();
    } catch (e) { if (view === 'history' && request === historyRequest) { renderHistory(); toast(e.message, true); } }
  };
}

function render() {
  root.setAttribute('aria-busy', 'false');
  if (!user) return renderAuth();
  if (view === 'settings' || !user.profile) return renderSettings();
  if (view === 'history') return renderHistory();
  renderDay();
}
function renderAuth() {
  root.innerHTML = `<section class="auth"><h1>Comida</h1><form id="auth-form" class="stack"><h2>${authMode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h2><div><label for="username">Usuario</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_.-]+" autocapitalize="none" spellcheck="false"></div><div><label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="${authMode === 'login' ? 'current-password' : 'new-password'}" required minlength="10" maxlength="128">${authMode === 'register' ? '<small>Al menos 10 caracteres.</small>' : ''}</div><p class="error" id="auth-error" role="alert" hidden></p><button class="primary" type="submit">${authMode === 'login' ? 'Entrar' : 'Crear cuenta'}</button></form><div class="auth-switch"><button class="text" data-action="auth-switch">${authMode === 'login' ? 'Crear una cuenta' : 'Ya tengo una cuenta'}</button></div></section>`;
  syncDock();
  document.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
    const error = document.querySelector('#auth-error'); error.hidden = true;
    try { const data = await api(`/api/${authMode}`, { method: 'POST', body: Object.fromEntries(new FormData(form)) }); user = data.user; view = user.profile ? 'day' : 'settings'; currentDate = localDate(); meals = []; week = null; render(); if (user.profile) await loadDay(); }
    catch (e) { error.textContent = e.message; error.hidden = false; button.disabled = false; }
  };
}
function dateLabel() { const label = new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${currentDate}T12:00:00`)); return currentDate === localDate() ? `Hoy, ${label}` : label; }
function calorieProgress(total, target) {
  return calorieProgressMarkup({ total, target, maintenance: user.profile.expenditure, unavailable: loadingDay || !!dayError });
}

function renderDay() {
  const totals = summarizeMeals(meals), total = totals.calories, target = week?.dailyCalories ?? user.profile.dailyCalories;
  root.innerHTML = `${header()}<div class="view-panel"><section class="daily-section" aria-label="Registro diario"><div class="date-nav"><button class="icon" data-action="prev" aria-label="Día anterior"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg></button><label class="date-field"><span>${esc(dateLabel())}</span><input id="day-date" type="date" value="${currentDate}" aria-label="Seleccionar fecha"></label><button class="icon" data-action="next" aria-label="Día siguiente"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button></div><div class="day-panel"><div class="calories" aria-live="polite"><div class="daily-counter ${loadingDay || dayError ? '' : total <= target ? 'within-budget' : total > user.profile.expenditure ? 'over-budget' : ''}" aria-label="Calorías del día: consumidas / ${total > target && Number.isFinite(user.profile.expenditure) ? 'mantenimiento / objetivo' : 'objetivo'}"><strong>${loadingDay ? '…' : dayError ? '—' : fmt(total)}</strong>${total > target && Number.isFinite(user.profile.expenditure) ? `<span class="maintenance"> / ${fmt(user.profile.expenditure)}</span><span class="target exceeded-target"> / <s>${fmt(target)}</s></span>` : `<span class="target"> / ${fmt(target)}</span>`}<span class="calorie-unit"> kcal</span></div><div class="weekly-counter ${week ? week.total <= week.target ? 'within-budget' : Number.isFinite(week.maintenance) && week.total > week.maintenance ? 'over-budget' : '' : ''}" aria-label="Calorías de la semana: consumidas / ${week && week.total > week.target && Number.isFinite(week.maintenance) ? 'mantenimiento / objetivo' : 'objetivo'}" title="Semana de domingo a sábado"><span>${week ? fmt(week.total) : '—'}</span>${week && week.total > week.target && Number.isFinite(week.maintenance) ? `<span class="weekly-maintenance"> / ${fmt(week.maintenance)}</span><span class="weekly-target exceeded-target"> / <s>${fmt(week.target)}</s></span>` : `<span class="weekly-target"> / ${week ? fmt(week.target) : '—'}</span>`} kcal<span class="sr-only"> · Semana de domingo a sábado</span></div>${calorieProgress(total, target)}</div>${macroSummary(totals, { ...user.profile, dailyCalories: target, macroPlan: getMacroPlan({ ...user.profile, dailyCalories: target }) })}<button class="primary wide capture" data-action="photo" ${uploading ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 5 9.5 3h5L16 5h4a1 1 0 0 1 1 1v14H3V6a1 1 0 0 1 1-1z"/><circle cx="12" cy="12" r="4"/></svg>${uploading ? 'Guardando foto…' : 'Tomar foto'}</button><button class="wide describe-button" data-action="describe" ${uploading ? 'disabled' : ''}>Describir comida</button><input type="file" id="photo-input" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" hidden><div class="meals">${loadingDay ? '<p class="empty" role="status">Cargando…</p>' : dayError ? `<p class="error">${esc(dayError)}</p><button class="text" data-action="retry-day">Reintentar</button>` : meals.length ? meals.map(m => `<button class="meal" data-meal="${m.id}">${m.photoUrl ? `<img src="${m.photoUrl}" alt="" loading="lazy">` : '<span class="text-meal-icon" aria-hidden="true">≡</span>'}<span class="name"><strong>${esc(m.selected?.name || 'Elegir comida')}</strong><small>${esc(m.selected?.portion || 'Pendiente de confirmar')}</small>${m.selected ? `<small>${hasMacros(m.selected) ? macroText(m.selected) : 'Sin macros · reevaluar'}</small>` : ''}</span><span class="kcal">${m.selected ? `${fmt(m.selected.calories)} kcal` : '…'}</span></button>`).join('') : '<p class="empty">Todavía no registraste comidas.</p>'}</div></div></section>${footer()}</div>`;
  syncDock();
  document.querySelector('#day-date').onchange = e => { changeDay(e.target.value).catch(e => toast(e.message, true)); };
  document.querySelector('#photo-input').onchange = uploadPhoto;
}
async function loadDay() {
  const request = ++dayRequest; const cached = sectionCache.peek(`/api/day?date=${currentDate}`); loadingDay = !cached; dayError = ''; meals = cached?.meals || []; week = cached?.week || null; if (view === 'day' && user?.profile) render();
  try { const data = await api(`/api/day?date=${currentDate}`); if (request === dayRequest) { meals = data.meals; week = data.week || null; loadedDate = currentDate; } }
  catch (error) { if (request === dayRequest && !cached) dayError = error.message; throw error; }
  finally { if (request === dayRequest) { loadingDay = false; if (view === 'day' && user?.profile) render(); } }
}
function renderSettings() {
  const p = user.profile || {};
  const numberField = (name, label, min, max, step = '1') => `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="number" inputmode="${step === '1' ? 'numeric' : 'decimal'}" min="${min}" max="${max}" step="${step}" value="${p[name] ?? ''}" required></div>`;
  root.innerHTML = `${header('Configuración')}<div class="view-panel"><form id="profile-form" class="stack"><div class="grid">${numberField('height', 'Altura (cm)', 100, 250)}${numberField('age', 'Edad', 18, 100)}${numberField('weight', 'Peso actual (kg)', 30, 350, '0.1')}<div class="field"><label for="gender">Género</label><select id="gender" name="gender" required><option value="">Seleccionar</option><option value="female" ${p.gender === 'female' ? 'selected' : ''}>Mujer</option><option value="male" ${p.gender === 'male' ? 'selected' : ''}>Hombre</option></select></div></div><div class="field"><label for="activity">Nivel de actividad</label><select id="activity" name="activity" required>${[['', 'Seleccionar'], ['sedentary', 'Sedentario · poco o ningún ejercicio'], ['light', 'Ligero · 1–3 días por semana'], ['moderate', 'Moderado · 3–5 días por semana'], ['active', 'Alto · 6–7 días por semana'], ['very_active', 'Muy alto · trabajo físico y ejercicio']].map(([value, label]) => `<option value="${value}" ${p.activity === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="section-gap"><h2>Tu objetivo</h2><div class="grid">${numberField('targetWeight', 'Peso objetivo (kg)', 30, 350, '0.1')}<div class="field"><label for="targetDate">Para qué fecha</label><input id="targetDate" name="targetDate" type="date" min="${shiftDate(localDate(), 1)}" value="${esc(p.targetDate || '')}" required></div></div></div><div id="estimate" class="estimate" ${p.dailyCalories ? '' : 'hidden'}>${p.dailyCalories ? estimateMarkup(p) : ''}</div><p id="profile-error" class="error" role="alert" hidden></p><button class="primary" type="submit">Guardar configuración</button><small>El gasto, las calorías y los macros son estimaciones para adultos.</small></form>${footer()}</div>`;
  syncDock();
  const form = document.querySelector('#profile-form');
  const profileInput = () => { const value = Object.fromEntries(new FormData(form)); for (const key of ['height', 'age', 'weight', 'targetWeight']) value[key] = Number(value[key]); return value; };
  form.oninput = () => {
    const v = profileInput(), el = document.querySelector('#estimate');
    if (!v.height || !v.age || !v.weight || !v.targetWeight || !v.gender || !v.activity || v.targetDate <= localDate()) { el.hidden = true; return; }
    const factor = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 }[v.activity];
    const expenditure = Math.round((10 * v.weight + 6.25 * v.height - 5 * v.age + (v.gender === 'male' ? 5 : -161)) * factor);
    const days = Math.round((Date.parse(v.targetDate) - Date.parse(localDate())) / 86400000);
    const requested = Math.round(expenditure + (v.targetWeight - v.weight) * 7700 / days);
    const { minimum, maximum } = getCalorieLimits({ ...v, expenditure });
    const dailyCalories = Math.round(Math.max(minimum, Math.min(maximum, requested)));
    el.innerHTML = estimateMarkup({ ...v, startDate: localDate(), expenditure, dailyCalories, requestedCalories: requested, limited: dailyCalories !== requested }); el.hidden = false;
  };
  form.onsubmit = async e => {
    e.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true; const error = document.querySelector('#profile-error'); error.hidden = true;
    try { const data = await api('/api/profile', { method: 'PUT', body: profileInput() }); user.profile = data.profile; await switchView('day'); toast('Configuración guardada'); }
    catch (e) { error.textContent = e.message; error.hidden = false; button.disabled = false; }
  };
}
function macroText(option) {
  return hasMacros(option) ? `Proteínas ${fmt(option.protein)} g · Grasas ${fmt(option.fat)} g · Carbohidratos ${fmt(option.carbs)} g` : 'Sin datos de macronutrientes';
}
function macroSummary(totals, profile) {
  const plan = profile.macroPlan || getMacroPlan(profile);
  return `<dl class="macro-summary" aria-label="Macronutrientes diarios">${[['protein', 'Proteínas'], ['fat', 'Grasas'], ['carbs', 'Carbohidratos']].map(([key, label]) => `<div><dt>${label}</dt><dd><strong>${loadingDay ? '…' : dayError ? '—' : totals.missingMacros && !totals.knownMeals ? '—' : fmt(totals[key])}</strong><span> / ${fmt(plan[key])} g</span></dd></div>`).join('')}</dl>${totals.missingMacros ? `<p class="macro-note">Faltan macros de ${totals.missingMacros} ${totals.missingMacros === 1 ? 'comida' : 'comidas'}. Abrí la comida y reevaluá la foto para completar el total.</p>` : ''}`;
}
function estimateMarkup(p) {
  const plan = getMacroPlan(p), projection = getGoalProjection(p);
  const goal = { lose: 'Bajar de peso', gain: 'Subir de peso', maintain: 'Mantener el peso' }[plan.goal];
  const date = value => new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
  return `<p>Gasto estimado: <strong>${fmt(p.expenditure)} kcal/día</strong><br>Objetivo diario base: <strong>${fmt(p.dailyCalories)} kcal</strong></p><p>${goal}<br>${macroText(plan)}</p>${p.limited ? `<p>${p.requestedCalories < 0 || plan.goal === 'lose' ? 'El plazo solicitado requiere un déficit superior al máximo de 1.200 kcal/día. Se aplica ese límite.' : 'Se aplica un superávit máximo de 500 kcal/día.'}</p>` : ''}${projection ? `<p>Peso estimado al ${date(p.targetDate)}: <strong>${fmt(projection.projectedWeight)} kg</strong><br>${projection.estimatedTargetDate ? `Fecha estimada para llegar a ${fmt(p.targetWeight)} kg: <strong>${date(projection.estimatedTargetDate)}</strong>` : 'Con este ajuste no se proyecta alcanzar el peso objetivo.'}</p><small>Proyección aproximada desde ${date(p.startDate)}, con gasto constante y cumplimiento del objetivo base.</small>` : ''}<p class="budget-explanation">El presupuesto diario y los macros se ajustan con las calorías semanales restantes, de domingo a sábado. El gasto estimado no cambia por este reparto.</p>`;
}

function shiftDate(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
async function preparePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('El navegador no pudo abrir la foto. Usá JPG, PNG o WebP.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    let width = Math.max(1, Math.round(image.naturalWidth * scale));
    let height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No se pudo preparar la foto en este navegador.');
    for (let size = 0; size < 6; size++) {
      canvas.width = width; canvas.height = height;
      context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      for (const quality of [0.82, 0.72, 0.6]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob || blob.type !== 'image/jpeg') throw new Error('No se pudo comprimir la foto. Probá con otra imagen.');
        if (blob.size <= 500 * 1024) return blob;
      }
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }
    throw new Error('No se pudo reducir la foto. Probá con otra imagen.');
  } finally { URL.revokeObjectURL(url); }
}
async function uploadPhoto(e) {
  const file = e.target.files[0]; if (!file) return;
  if (uploading) return;
  if (file.size > 40 * 1024 * 1024) return toast('La foto supera los 40 MB.', true);
  const date = currentDate;
  uploading = true; renderDay();
  dialog.innerHTML = `${modalHeader('Analizar comida')}<div class="dialog-body">${processingMarkup('photo', 'Recibiendo foto…')}</div>`; showModal();
  try {
    const photo = await preparePhoto(file);
    const data = new FormData(); data.append('date', date); data.append('photo', photo, 'comida.jpg');
    const { meal } = await api('/api/meals', { method: 'POST', body: data });
    if (meal.date === currentDate) meals.push(meal);
    activeMeal = meal; await runAnalysis('', 'photo', dialog.open);
  } catch (e) { closeModal(); toast(e.message, true); }
  finally { uploading = false; if (view === 'day' && user) render(); }
}
function modalHeader(title) {
  return `<div class="dialog-head"><h2 id="meal-title">${esc(title)}</h2><button type="button" class="modal-close" data-action="close" aria-label="Cerrar" title="Cerrar">×</button></div>`;
}
function openDescription() {
  if (analysisBusy || audioBusy || uploading) return toast('Esperá a que termine el análisis actual.');
  const date = currentDate;
  dialog.innerHTML = `${modalHeader('Describir comida')}<div class="dialog-body"><form id="description-form">${voice.button()}</form></div>`;
  showModal();
  const form = document.querySelector('#description-form');
  voice.bind(form, async (description, source) => {
    showProcessing(form, source, 'Analizando comida…');
    const { meal } = await api('/api/meals/describe', { method: 'POST', body: { date, description } });
    if (meal.date === currentDate) meals.push(meal);
    activeMeal = meal; if (view === 'day') render(); await runAnalysis('', source, dialog.open);
  });
  form.querySelector('[data-action=record-audio]').focus({ preventScroll: true });
}

function optionMarkup(analysis, selected) {
  return `<div class="options">${analysis.options.map((o, i) => {
    const chosen = selected?.analysisId === analysis.id && selected?.optionIndex === i;
    return `<button class="option ${chosen ? 'chosen' : ''}" data-analysis="${analysis.id}" data-option="${i}" aria-pressed="${chosen}" ${analysisBusy ? 'disabled' : ''}><span class="option-label"><strong>${esc(o.name)}</strong><small>${esc(o.portion)}</small><small class="option-macros">${macroText(o)}</small><small>${esc(o.details)}</small></span><span class="kcal">${fmt(o.calories)} kcal${chosen ? ' ✓' : ''}</span></button>`;
  }).join('')}</div>`;
}
function repeatMealActions() {
  return `<div class="meal-actions"><div class="repeat-control"><button type="button" class="primary wide capture repeat-button" data-action="repeat-meal"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/></svg>Repetir comida</button><input type="date" id="repeat-date" aria-label="Fecha para repetir comida" tabindex="-1"></div><button type="button" class="wide delete-meal-button" data-action="delete-meal">Eliminar comida</button></div>`;
}
function openMeal() {
  const m = activeMeal; if (!m) return;
  const latest = m.analyses[0];
  if (analysisBusy) {
    voice.cancel({ restore: false });
    dialog.innerHTML = `${modalHeader('Analizar comida')}<div class="dialog-body">${processingMarkup(analysisSource)}</div>`;
    showModal(); return;
  }
  dialog.innerHTML = `${modalHeader(m.selected ? 'Editar comida' : 'Elegir comida')}<div class="dialog-body">${m.selected && !hasMacros(m.selected) ? '<p class="description">La opción elegida no tiene macros. Reevaluá la comida y elegí una nueva opción para completarlos.</p>' : ''}${m.photoUrl ? `<img class="meal-photo" src="${m.photoUrl}" alt="Foto de tu comida">` : `<p class="description">${esc(m.description)}</p>`}${latest ? `<p class="description">${esc(latest.description)}</p>${repeatMealActions()}${optionMarkup(latest, m.selected)}${!latest.options.length ? '<p class="description">Añadí detalles para ajustar el análisis.</p>' : '<small>Elegí una opción para guardar sus calorías. Son estimaciones.</small>'}` : `<p class="description">La comida está guardada. Analizala para recibir opciones.</p>${repeatMealActions()}`}${m.analyses.length > 1 ? `<details class="history"><summary>Opciones anteriores</summary>${m.analyses.slice(1).map(a => `<p class="hint">${esc(a.instructions || 'Análisis inicial')}</p>${optionMarkup(a, m.selected)}`).join('')}</details>` : ''}<form id="reevaluate" class="reevaluate"><p class="description">${latest ? '¿Querés ajustar el análisis?' : 'Detalles de la comida (opcional)'}</p>${voice.button()}</form></div>`;
  showModal();
  voice.bind(document.querySelector('#reevaluate'), (instructions, source) => runAnalysis(instructions, source));
  const picker = dialog.querySelector('#repeat-date'), repeatButton = dialog.querySelector('[data-action=repeat-meal]');
  let repeating = false;
  picker.disabled = !m.selected;
  picker.onchange = async () => {
    const date = picker.value;
    if (!date || repeating) return;
    repeating = true; repeatButton.disabled = true; picker.setAttribute('aria-busy', 'true');
    picker.disabled = true;
    const identity = user?.id, navigation = navigationRequest;
    try {
      const { meal } = await api(`/api/meals/${m.id}/repeat`, { method: 'POST', body: { date } });
      if (user?.id !== identity) return;
      if (picker.isConnected && dialog.open) closeModal();
      const label = new Intl.DateTimeFormat('es-UY').format(new Date(`${date}T12:00:00Z`));
      toast(`Comida repetida para el ${label}`);
      if (view === 'day') {
        if (meal.date === currentDate) meals.push(meal);
        if (week && date >= week.start && date <= week.end) week.total += meal.selected.calories;
        render();
        try {
          const data = await api(`/api/day?date=${currentDate}`);
          if (user?.id === identity && navigationRequest === navigation && view === 'day') { meals = data.meals; week = data.week; render(); }
        } catch (error) { if (user?.id === identity) toast(error.message, true); }
      }
    } catch (error) { toast(error.message, true); }
    finally {
      repeating = false; repeatButton.disabled = false; picker.removeAttribute('aria-busy');
      picker.disabled = false;
    }
  };

}
function updateMeal(meal) { const i = meals.findIndex(m => m.id === meal.id); if (i >= 0) { if (week) week.total += (meal.selected?.calories || 0) - (meals[i].selected?.calories || 0); meals[i] = meal; } }
async function runAnalysis(instructions, source = 'text', present = true) {
  if (analysisBusy || !activeMeal) return;
  const mealId = activeMeal.id; analysisBusy = true; analysisSource = source; if (present) openMeal();
  try {
    const data = await api(`/api/meals/${mealId}/analyze`, { method: 'POST', body: { instructions } });
    updateMeal(data.meal); if (activeMeal?.id === mealId) activeMeal = data.meal;
    if (!dialog.open) toast('Análisis listo. Abrí la comida para elegir una opción.');
  } catch (e) { toast(e.message, true); }
  finally { analysisBusy = false; if (user && view === 'day') render(); if (dialog.open && activeMeal?.id === mealId) openMeal(); }
}
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button || button.disabled) return;
  try {
    if (button.dataset.historyDate) { await switchView('day', button.dataset.historyDate); return; }
    if (button.dataset.meal) { if (audioBusy) return toast('Esperá a que termine la transcripción.'); if (analysisBusy && activeMeal?.id !== button.dataset.meal) return toast('Esperá a que termine el análisis actual.'); activeMeal = meals.find(m => m.id === button.dataset.meal); openMeal(); return; }
    if (button.dataset.analysis) {
      button.disabled = true;
      try { const { meal } = await api(`/api/meals/${activeMeal.id}/selection`, { method: 'PUT', body: { analysisId: button.dataset.analysis, optionIndex: Number(button.dataset.option) } }); updateMeal(meal); activeMeal = meal; closeModal(); render(); toast('Comida guardada'); }
      finally { button.disabled = false; }
      return;
    }
    switch (button.dataset.action) {
      case 'auth-switch': authMode = authMode === 'login' ? 'register' : 'login'; render(); break;
      case 'day': case 'history': case 'settings': await switchView(button.dataset.action); break;
      case 'back': await switchView('day'); break;
      case 'prev': case 'next': await changeDay(shiftDate(pendingDate || currentDate, button.dataset.action === 'prev' ? -1 : 1)); break;
      case 'retry-day': await changeDay(currentDate, true); break;
      case 'describe': openDescription(); break;
      case 'repeat-meal': {
        if (!activeMeal?.selected) { toast('Elegí una opción antes de repetir la comida.'); break; }
        const picker = dialog.querySelector('#repeat-date');
        try {
          if (typeof picker.showPicker === 'function') picker.showPicker();
          else { picker.focus({ preventScroll: true }); picker.click(); }
        } catch { picker.focus({ preventScroll: true }); picker.click(); }
        break;
      }
      case 'photo': document.querySelector('#photo-input').click(); break;
      case 'record-audio': await voice.record(); break;
      case 'write-food': voice.write(); break;
      case 'input-options': voice.choose(); break;
      case 'close': closeModal(); break;
      case 'logout': await api('/api/logout', { method: 'POST' }); user = null; meals = []; week = null; loadedDate = null; dayRequest++; navigationRequest++; historyRequest++; historyData = null; closeModal(); render(); break;
      case 'delete-meal': {
        if (!confirm('¿Eliminar esta comida y su foto?')) return;
        button.disabled = true;
        try { await api(`/api/meals/${activeMeal.id}`, { method: 'DELETE' }); if (week) week.total -= activeMeal.selected?.calories || 0; meals = meals.filter(m => m.id !== activeMeal.id); closeModal(); activeMeal = null; render(); toast('Comida eliminada'); }
        finally { button.disabled = false; }
        break;
      }
    }
  } catch (e) { toast(e.message, true); }
});
(async () => {
  try { const data = await api('/api/me'); user = data.user; currentDate = data.today; view = user.profile ? 'day' : 'settings'; if (user.profile) await loadDay(); else render(); }
  catch (e) { render(); if (!e.message.includes('Iniciá sesión')) toast(e.message, true); }
})();

dialog.addEventListener('close', () => { if (!dialog.open) voice.cancel(); });

let backdropPress = false;
function outsideDialog(event) {
  const rect = dialog.getBoundingClientRect();
  return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
}
dialog.addEventListener('pointerdown', event => { backdropPress = outsideDialog(event); });
dialog.addEventListener('click', event => {
  if (backdropPress && outsideDialog(event)) closeModal();
  backdropPress = false;
});

bindDaySwipe(root, {
  isEnabled: () => view === 'day' && !!user?.profile && !dialog.open,
  onSwipe: direction => { changeDay(shiftDate(pendingDate || currentDate, direction)).catch(error => toast(error.message, true)); }
});

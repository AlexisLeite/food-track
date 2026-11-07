import { randomUUID } from 'node:crypto';
import { profileAt } from './history.js';
import { validDate, today } from './nutrition.js';
import { logExecution } from './execution-log.js';
const fail = (status, message) => Object.assign(new Error(message), { status });
export function workoutEstimate(result, weight) {
  if (!Number.isFinite(weight) || weight < 30 || weight > 350) throw fail(400, 'No hay un peso válido para esa fecha.');
  if (!result || typeof result.details !== 'string' || result.details.length > 1500 || !Array.isArray(result.activities) || result.activities.length > 20) throw fail(502, 'La estimación del entrenamiento no es válida.');
  if (!result.activities.length) throw fail(400, result.details || 'Indicá qué entrenamiento hiciste y cuánto duró.');
  const activities = result.activities.map(a => {
    if (!a || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 200 || !Number.isFinite(a.minutes) || a.minutes <= 0 || a.minutes > 720 || !Number.isFinite(a.met) || a.met < 1 || a.met > 25) throw fail(502, 'La duración o intensidad estimada no es válida.');
    // Only energy above resting expenditure; rest is already included in the base.
    return { name: a.name, minutes: a.minutes, met: a.met, calories: Math.round((a.met - 1) * 3.5 * weight / 200 * a.minutes) };
  });
  if (activities.reduce((sum, a) => sum + a.minutes, 0) > 720) throw fail(400, 'El entrenamiento no puede superar 12 horas.');
  return { activities, weight, details: result.details, calories: activities.reduce((sum, a) => sum + a.calories, 0) };
}
export function workoutOptions(result, weight) {
  if (!Array.isArray(result?.options) || result.options.length !== 3) throw fail(502, 'No se recibieron tres opciones de entrenamiento válidas.');
  const options = result.options.map(option => {
    if (typeof option?.name !== 'string' || !option.name.trim() || option.name.length > 200) throw fail(502, 'La opción de entrenamiento no es válida.');
    return { name: option.name, ...workoutEstimate(option, weight) };
  });
  return { options, weight, selectedIndex: null };
}
export const workoutData = row => ({ id: row.id, date: row.date, description: row.description, estimate: JSON.parse(row.estimate), confirmed: !!row.confirmed, calories: row.confirmed ? JSON.parse(row.estimate).calories : 0, createdAt: row.created_at });
export function installWorkouts(app, db, withSubmission, analyzer) {
  db.exec(`CREATE TABLE IF NOT EXISTS workouts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,date TEXT NOT NULL,description TEXT NOT NULL,estimate TEXT NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS workouts_user_date ON workouts(user_id,date);`);
  const getProfile = (userId, date) => profileAt(db.prepare('SELECT date,profile FROM profile_timeline WHERE user_id=? AND date<=? ORDER BY date').all(userId, date), date);
  const owned = req => {
    const row = db.prepare('SELECT * FROM workouts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!row) throw fail(404, 'No se encontró el entrenamiento.');
    return row;
  };
  app.get('/api/workouts', (req, res) => {
    const date = req.query.date || today();
    if (!validDate(date)) throw fail(400, 'Fecha inválida.');
    res.json({ workouts: db.prepare('SELECT * FROM workouts WHERE user_id=? AND date=? ORDER BY created_at').all(req.user.id, date).map(workoutData), profile: getProfile(req.user.id, date) });
  });
  app.post('/api/workouts', withSubmission(async (req, res) => {
    if (req.user.enable_codex_extraction !== 1) throw fail(403, 'No tenés autorización para usar esta función. Contactá con el administrador.');
    const { date, description } = req.body || {};
    if (!validDate(date) || date > today()) throw fail(400, 'Elegí una fecha de hoy o anterior.');
    const profile = getProfile(req.user.id, date);
    if (profile?.expenditureMode !== 'workouts') throw fail(400, 'Elegí el perfil de gasto Por entrenamientos para esa fecha.');
    if (typeof description !== 'string' || !description.trim() || description.length > 1500) throw fail(400, 'Describí el entrenamiento en hasta 1500 caracteres.');
    logExecution('workout_analysis', { phase: 'started', userId: req.user.id });
    try {
      const estimate = workoutOptions(await analyzer(description), profile.weight);
      if (db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(req.user.id)?.enable_codex_extraction !== 1) throw fail(403, 'No tenés autorización para usar esta función. Contactá con el administrador.');
      const id = randomUUID();
      db.prepare('INSERT INTO workouts(id,user_id,date,description,estimate,created_at) VALUES(?,?,?,?,?,?)').run(id, req.user.id, date, description.trim(), JSON.stringify(estimate), new Date().toISOString());
      logExecution('workout_analysis', { phase: 'completed', userId: req.user.id, workoutId: id });
      res.status(201).json({ workout: workoutData(db.prepare('SELECT * FROM workouts WHERE id=?').get(id)) });
    } catch (e) { logExecution('workout_analysis', { phase: 'failed', userId: req.user.id }); e.status ||= 502; throw e; }
  }));
  app.put('/api/workouts/:id/confirm', (req, res) => {
    const row = owned(req);
    if (getProfile(req.user.id, row.date)?.expenditureMode !== 'workouts') throw fail(400, 'Este día no usa el perfil Por entrenamientos.');
    let estimate = JSON.parse(row.estimate);
    if (estimate.options) {
      const index = req.body?.optionIndex ?? (row.confirmed ? estimate.selectedIndex : null);
      if (!Number.isInteger(index) || index < 0 || index >= estimate.options.length) throw fail(400, 'Elegí una de las opciones de entrenamiento.');
      estimate = { ...estimate, ...estimate.options[index], selectedIndex: index };
    }
    db.prepare('UPDATE workouts SET confirmed=1,estimate=? WHERE id=?').run(JSON.stringify(estimate), row.id);
    res.json({ workout: workoutData(db.prepare('SELECT * FROM workouts WHERE id=?').get(row.id)) });
  });
  app.delete('/api/workouts/:id', (req, res) => { const row = owned(req); db.prepare('DELETE FROM workouts WHERE id=?').run(row.id); res.json({ ok: true }); });
}

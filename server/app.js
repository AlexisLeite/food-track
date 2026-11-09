import { createExtractionQueue } from './extraction-queue.js';
import { installUsageLimits } from './usage-limits.js';
import { createSemaphore } from './semaphore.js';
import { installTokenUsage, withTokenTracking, canViewStatistics, tokenStatistics } from './token-usage.js';
import { installWorkouts, workoutData } from './workouts.js';
import { analyzeWorkout } from './codex.js';
import { migrateProfileVersions, appendProfileVersion } from './profile-versions.js';
import { submissionHandler, submissionReceipt } from './submissions.js';
import { runAssistant, validateMessages } from './assistant.js';
import { migrateCodexAccess } from './codex-access.js';
import { captureDiagnosticAudio, recordAudioResult } from './audio-capture.js';
import { createPhotoStorage } from './photo-storage.js';
import { withRequestLog, logExecution } from './execution-log.js';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateProfile, validDate, today, withMacroPlan } from './nutrition.js';
import { analyzePhoto, analyzeDescription, validateAnalysis } from './codex.js';
import { transcribeAudio } from './audio.js';
import { summarizeMeals } from '../public/nutrition.js';
import { migrateCaloriePolicy } from './calorie-policy.js';
import { buildHistory, dateOffset, buildWeek, weekRange, profileAt } from './history.js';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
export async function createApplication({ dataDir = path.resolve(process.env.DATA_DIR || 'data'), photoStorage = createPhotoStorage(dataDir), analyzer = analyzePhoto, descriptionAnalyzer = analyzeDescription, workoutAnalyzer = analyzeWorkout, assistantRunner = runAssistant, origin = process.env.APP_ORIGIN || 'http://localhost:3086', secureCookies = process.env.COOKIE_SECURE === 'true' } = {}) {
  await photoStorage.init();
  const db = new DatabaseSync(path.join(dataDir, 'foodtrack.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, profile TEXT, enable_codex_extraction INTEGER NOT NULL DEFAULT 0 CHECK(enable_codex_extraction IN (0,1)));
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meals(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, photo TEXT NOT NULL, selected TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS meals_user_date ON meals(user_id,date);
    CREATE TABLE IF NOT EXISTS analyses(id TEXT PRIMARY KEY, meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE, instructions TEXT NOT NULL, description TEXT NOT NULL, options TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meal_descriptions(meal_id TEXT PRIMARY KEY REFERENCES meals(id) ON DELETE CASCADE, description TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_goals(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, profile TEXT NOT NULL, PRIMARY KEY(user_id,date));
    PRAGMA user_version=1;`);
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'theme')) {
    db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark' CHECK(theme IN ('dark','light'))");
  }
  await migrateCodexAccess(db, dataDir);
  await migrateProfileVersions(db, dataDir);
  await migrateCaloriePolicy(db, dataDir);
  const tokenStore = installTokenUsage(db);
  const limits = installUsageLimits(db);
  const extractionQueue = createExtractionQueue(db, { runAs: (userId, callback) => withTokenTracking(tokenStore(userId), callback) });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const requestId = randomUUID(), started = Date.now();
    res.set('X-Request-ID', requestId);
    withRequestLog(requestId, () => {
      const fields = () => ({ requestId, method: req.method, path: req.path, userId: req.user?.id, elapsedMs: Date.now() - started });
      logExecution('api_request', { ...fields(), phase: 'started' });
      res.once('finish', () => logExecution('api_request', { ...fields(), phase: 'completed', status: res.statusCode }));
      res.once('close', () => { if (!res.writableEnded) logExecution('api_request', { ...fields(), phase: 'disconnected' }); });
      next();
    });
  });
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Permissions-Policy': 'camera=(self), microphone=(self)' });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (req.get('X-Foodtrack') !== '1' || (req.get('Origin') && req.get('Origin') !== origin))) return next(fail(403, 'Petición no permitida. Recargá la página.'));
    next();
  });
  app.use('/api/chat', express.json({ limit: '192kb' }));
  app.use(express.json({ limit: '16kb' }));
  const attempts = new Map();
  const authLimit = (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.reset < now) attempts.delete(key);
    const key = req.ip;
    const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60000 };
    entry.count++; attempts.set(key, entry);
    if (entry.count > 30) return next(fail(429, 'Demasiados intentos. Esperá 15 minutos.'));
    next();
  };
  async function newSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), userId, Date.now() + 30 * 86400000);
    res.cookie('foodtrack_session', token, { httpOnly: true, secure: secureCookies, sameSite: 'strict', maxAge: 30 * 86400000, path: '/' });
  }
  const publicUser = user => ({ id: user.id, username: user.username, theme: user.theme || 'dark', canChat: user.enable_codex_extraction === 1, canViewStatistics: canViewStatistics(user), profile: user.profile ? withMacroPlan(JSON.parse(user.profile)) : null });
  const credentials = req => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || typeof password !== 'string' || password.length < (req.path === '/api/register' ? 10 : 1) || password.length > 128) throw fail(400, 'Usá un usuario de 3 a 32 letras, números, puntos o guiones y una contraseña de 10 a 128 caracteres.');
    return { username: username.toLowerCase(), password };
  };
  app.post('/api/register', authLimit, async (req, res) => {
    const { username, password } = credentials(req);
    const salt = randomBytes(16).toString('hex');
    const encoded = `${salt}:${Buffer.from(await scrypt(password, salt, 64)).toString('hex')}`;
    const id = randomUUID();
    try { db.prepare('INSERT INTO users(id,username,password) VALUES (?,?,?)').run(id, username, encoded); }
    catch (e) { if (e.message.includes('UNIQUE')) throw fail(409, 'Ese usuario ya existe.'); throw e; }
    await newSession(res, id);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  });
  app.post('/api/login', authLimit, async (req, res) => {
    const { username, password } = credentials(req);
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const [salt, encoded] = user ? user.password.split(':') : ['0000000000000000', '0'.repeat(128)];
    const derived = Buffer.from(await scrypt(password, salt, 64));
    if (!user || !timingSafeEqual(Buffer.from(encoded, 'hex'), derived)) throw fail(401, 'Usuario o contraseña incorrectos.');
    await newSession(res, user.id);
    res.json({ user: publicUser(user) });
  });
  app.use('/api', (req, res, next) => {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('foodtrack_session='))?.slice(18);
    const user = token && db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(hash(token), Date.now());
    if (!user) return next(fail(401, 'Iniciá sesión para continuar.'));
    req.user = user; req.sessionHash = hash(token); withTokenTracking(tokenStore(user.id), next);
  });
  app.get('/api/statistics', (req, res) => {
    res.set('Cache-Control','no-store');
    if (!canViewStatistics(req.user)) throw fail(403, 'No tenés autorización para ver estas estadísticas.');
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    if (![7,30,90].includes(days)) throw fail(400, 'Elegí un período de 7, 30 o 90 días.');
    let selectedUser = null;
    if (req.query.username !== undefined) {
      if (typeof req.query.username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(req.query.username)) throw fail(400, 'Usuario inválido.');
      selectedUser = db.prepare('SELECT id,username FROM users WHERE username=?').get(req.query.username.toLowerCase());
      if (!selectedUser) throw fail(404, 'No se encontró el usuario.');
    }
    res.json({ ...tokenStatistics(db, days, selectedUser?.id ?? null), selectedUser: selectedUser?.username ?? null });
  });
  app.get('/api/usage', (req, res) => res.json(limits.snapshot(req.user.id)));
  app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user), today: today() }));
  app.put('/api/password', authLimit, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword.length || currentPassword.length > 128) throw fail(400, 'Ingresá tu contraseña actual.');
    if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) throw fail(400, 'La nueva contraseña debe tener entre 10 y 128 caracteres.');
    if (newPassword !== confirmPassword) throw fail(400, 'La nueva contraseña y la confirmación no coinciden.');
    const [salt, encoded] = req.user.password.split(':');
    const derived = Buffer.from(await scrypt(currentPassword, salt, 64));
    if (!timingSafeEqual(Buffer.from(encoded, 'hex'), derived)) throw fail(400, 'La contraseña actual no es correcta.');
    const newSalt = randomBytes(16).toString('hex');
    const password = `${newSalt}:${Buffer.from(await scrypt(newPassword, newSalt, 64)).toString('hex')}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('UPDATE users SET password=? WHERE id=? AND password=?').run(password, req.user.id, req.user.password);
      if (!result.changes) throw fail(400, 'La contraseña cambió mientras enviabas la solicitud. Volvé a intentarlo.');
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(req.user.id, req.sessionHash);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ ok:true });
  });
  app.put('/api/preferences', (req, res) => {
    const theme = req.body?.theme;
    if (!['dark', 'light'].includes(theme)) throw fail(400, 'Elegí un tema oscuro o claro.');
    db.prepare('UPDATE users SET theme=? WHERE id=?').run(theme, req.user.id);
    res.json({ theme });
  });
  app.post('/api/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(req.sessionHash); res.clearCookie('foodtrack_session', { path: '/', secure: secureCookies, httpOnly: true, sameSite: 'strict' }); res.json({ ok: true }); });
  const userWorkouts = userId => db.prepare('SELECT * FROM workouts WHERE user_id=? ORDER BY date,created_at').all(userId).map(workoutData);
  const activeChats = new Set();
  const chatQueue = createSemaphore(3);
  app.post('/api/chat', async (req, res) => {
    if (req.user.enable_codex_extraction !== 1) throw fail(403, 'No tenés autorización para usar esta función. Contactá con el administrador.');
    const messages = validateMessages(req.body?.messages);
    const receipt = submissionReceipt(db, req);
    if (receipt?.response) {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      return res.end(`data: ${JSON.stringify({ type: 'message', ...receipt.response })}\n\n`);
    }
    if (activeChats.has(req.user.id)) throw fail(429, 'El asistente está ocupado. Esperá un momento.');
    const asOf = today(), start = dateOffset(asOf, -89);
    const meals = db.prepare('SELECT date,selected FROM meals WHERE user_id=? AND date<=? ORDER BY date').all(req.user.id, asOf);
    const goals = db.prepare('SELECT date,profile FROM profile_timeline WHERE user_id=? AND date<=? ORDER BY date').all(req.user.id, asOf);
    const profile = req.user.profile ? withMacroPlan(JSON.parse(req.user.profile)) : null;
    const recent = meals.filter(meal => meal.date >= start);
    const context = { today: asOf, timeZone: 'America/Montevideo', localTime: new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()), profile, week: profile ? buildWeek({ date: asOf, asOf, meals, goals, profile, workouts: userWorkouts(req.user.id) }) : null,
      history: buildHistory({ start, end: asOf, meals, goals, asOf, workouts: userWorkouts(req.user.id) }),
      workouts: userWorkouts(req.user.id).filter(w => w.date >= start && w.date <= asOf).map(({ date, description, calories, confirmed }) => ({ date, description, calories, confirmed })),
      meals: recent.slice(-500).map(meal => ({ date: meal.date, food: meal.selected ? (({ name, portion, calories, protein, fat, carbs, details }) => ({ name, portion, calories, protein, fat, carbs, details }))(JSON.parse(meal.selected)) : null })),
      coverage: { days: 90, totalMeals: recent.length, detailedMeals: Math.min(recent.length,500), note: 'Solo comidas confirmadas tienen nutrientes; detalle limitado a las últimas 500 comidas de 90 días. Los totales diarios incluyen todas.' } };
    // IDs, credentials, photo paths and other users never enter the assistant context.
    limits.take(req.user.id, 'chat', receipt?.id || randomUUID());
    activeChats.add(req.user.id);
    const controller = new AbortController();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (type, data) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    res.once('close', () => controller.abort());
    let releaseChat;
    try {
      send('status', { text: 'Esperando al asistente…' });
      releaseChat = await chatQueue.acquire(controller.signal);
      if (db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(req.user.id)?.enable_codex_extraction !== 1) throw fail(403, 'No tenés autorización para usar esta función. Contactá con el administrador.');
      send('status', { text: 'Revisando tus registros…' });
      const text = await assistantRunner({ context, messages, signal: controller.signal, onStatus: text => send('status', { text }), onText: text => {
        if (db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(req.user.id)?.enable_codex_extraction !== 1) controller.abort();
        else send('text', { text });
      } });
      // A permission revoked during a query must also block delivery.
      const allowed = db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(req.user.id);
      if (allowed?.enable_codex_extraction !== 1) throw new Error('No tenés autorización para usar esta función. Contactá con el administrador.');
      const response = { text, ...(receipt ? { submissionHash: receipt.id } : {}) };
      receipt?.save(200, response);
      send('message', response);
    } catch (error) {
      logExecution('assistant_request', { phase: 'failed', userId: req.user.id, aborted: controller.signal.aborted });
      if (!controller.signal.aborted) send('error', { text: error.message || 'El asistente no pudo responder.' });
    } finally { releaseChat?.(); clearInterval(heartbeat); activeChats.delete(req.user.id); res.end(); }
  });
  app.put('/api/profile', (req, res) => {
    let profile;
    try { profile = calculateProfile(req.body); } catch (e) { throw fail(400, e.message); }
    const encoded = JSON.stringify(profile);
    let versionId;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET profile=? WHERE id=?').run(encoded, req.user.id);
      versionId = appendProfileVersion(db, req.user.id, encoded);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    logExecution('profile_configuration_saved', { userId: req.user.id, versionId, effectiveDate: today() });
    res.json({ profile });
  });
  function ownedMeal(req) {
    const meal = db.prepare('SELECT * FROM meals WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!meal) throw fail(404, 'No se encontró esa comida.');
    return meal;
  }
  function mealData(meal) {
    const analyses = db.prepare('SELECT * FROM analyses WHERE meal_id=? ORDER BY created_at DESC, rowid DESC').all(meal.id).map(a => ({ ...a, options: JSON.parse(a.options) }));
    return { id: meal.id, date: meal.date, photoUrl: meal.photo ? `/api/meals/${meal.id}/photo` : null, description: meal.photo ? null : db.prepare('SELECT description FROM meal_descriptions WHERE meal_id=?').get(meal.id)?.description || '', selected: meal.selected ? JSON.parse(meal.selected) : null, analyses, createdAt: meal.created_at };
  }
  function insertAnalysis(mealId, instructions, result, id = randomUUID()) {
    validateAnalysis(result);
    db.prepare('INSERT INTO analyses(id,meal_id,instructions,description,options,created_at) VALUES (?,?,?,?,?,?)').run(id, mealId, instructions, result.description, JSON.stringify(result.options), new Date().toISOString());
  }
  function sendVersioned(req, res, data) {
    const etag = `"${hash(JSON.stringify(data))}"`;
    res.set('ETag', etag);
    // Proxies may weaken ETags after compressing an otherwise identical response.
    const revisions = (req.get('If-None-Match') || '').split(',').map(value => value.trim().replace(/^W\//, ''));
    if (revisions.includes(etag) || revisions.includes('*')) return res.status(304).end();
    return res.json(data);
  }
  app.get('/api/day', (req, res) => {
    if (!validDate(req.query.date)) throw fail(400, 'Fecha inválida.');
    const meals = db.prepare('SELECT * FROM meals WHERE user_id=? AND date=? ORDER BY created_at').all(req.user.id, req.query.date).map(mealData);
    const totals = summarizeMeals(meals);
    const { start, end } = weekRange(req.query.date);
    const weekMeals = db.prepare('SELECT date,selected FROM meals WHERE user_id=? AND date BETWEEN ? AND ?').all(req.user.id, start, end);
    const goals = db.prepare('SELECT date,profile FROM profile_timeline WHERE user_id=? AND date<=? ORDER BY date').all(req.user.id, end);
    const effectiveProfile = profileAt(goals, req.query.date);
    const week = { ...buildWeek({ date: req.query.date, asOf: today(), meals: weekMeals, goals, profile: effectiveProfile, workouts: userWorkouts(req.user.id) }), profile: withMacroPlan(effectiveProfile) };
    sendVersioned(req, res, { meals, week, total: totals.calories, macros: { protein: totals.protein, fat: totals.fat, carbs: totals.carbs, missingMeals: totals.missingMacros } });
  });
  app.get('/api/history', (req, res) => {
    const end = req.query.end || today();
    const length = req.query.days === undefined ? 7 : Number(req.query.days);
    if (!validDate(end) || ![7,30,90].includes(length)) throw fail(400, 'Elegí un período de 7, 30 o 90 días y una fecha válida.');
    const start = dateOffset(end, 1 - length);
    if (!validDate(start)) throw fail(400, 'Período inválido.');
    const balanceStart = dateOffset(start, -6);
    const rangeStart = weekRange(balanceStart).start, rangeEnd = weekRange(end).end;
    const meals = db.prepare('SELECT date,selected FROM meals WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date').all(req.user.id, rangeStart, rangeEnd);
    const goals = db.prepare('SELECT date,profile FROM profile_timeline WHERE user_id=? AND date<=? ORDER BY date').all(req.user.id, rangeEnd);
    const history = buildHistory({ start, end, meals, goals, asOf: today(), workouts: userWorkouts(req.user.id) });
    history.balanceDays = buildHistory({ start: balanceStart, end, meals, goals, asOf: today(), workouts: userWorkouts(req.user.id) }).days;
    sendVersioned(req, res, history);
  });
  const withSubmission = submissionHandler(db, { authorizeReplay: (req, response) => {
    if (response?.job) extractionQueue.retry(response.job.id, req.user.id);
    if (req.path.startsWith('/api/workouts') && req.user.enable_codex_extraction !== 1) throw fail(403, 'No tenés autorización para usar esta función. Contactá con el administrador.');
    if (/^\/api\/meals\/.*\/analyze$/.test(req.path)) {
      ownedMeal(req);
      if (req.user.enable_codex_extraction !== 1) throw Object.assign(fail(403, 'No tenés autorización para usar esta función. Contactá con el administrador.'), { code: 'CODEX_EXTRACTION_DISABLED' });
    }
  } });
  installWorkouts(app, db, withSubmission, workoutAnalyzer, extractionQueue, limits);
  app.get('/api/extractions/:id', (req, res) => res.json(extractionQueue.read(req.params.id, req.user.id)));
  app.post('/api/meals/describe', withSubmission((req, res) => {
    if (!req.user.profile) throw fail(400, 'Guardá tu configuración antes de añadir comidas.');
    const { date, description } = req.body || {};
    if (!validDate(date)) throw fail(400, 'Fecha inválida.');
    if (typeof description !== 'string' || !description.trim() || description.length > 1500) throw fail(400, 'Describí tu comida en hasta 1500 caracteres.');
    const id = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      limits.take(req.user.id, 'food', `meal:${id}`);
      db.prepare('INSERT INTO meals VALUES (?,?,?,?,?,?)').run(id, req.user.id, date, '', null, new Date().toISOString());
      db.prepare('INSERT INTO meal_descriptions VALUES (?,?)').run(id, description.trim());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.status(201).json({ meal: mealData(db.prepare('SELECT * FROM meals WHERE id=?').get(id)) });
  }));
  app.post('/api/meals/:id/repeat', async (req, res) => {
    const original = ownedMeal(req), date = req.body?.date;
    if (!validDate(date)) throw fail(400, 'Elegí una fecha válida.');
    if (!original.selected) throw fail(409, 'Elegí una opción antes de repetir la comida.');
    const id = randomUUID();
    let photo = original.photo ? `${id}.jpg` : '';
    let committed = false;
    try {
      if (photo) {
        try { await photoStorage.copy(original.photo, photo); }
        catch (error) { if (error.code !== 'ENOENT') throw error; photo = ''; }
      }
      const selected = JSON.parse(original.selected);
      const analyses = db.prepare('SELECT * FROM analyses WHERE meal_id=? ORDER BY created_at, rowid').all(original.id);
      const mapped = new Map(analyses.map(analysis => [analysis.id, randomUUID()]));
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO meals VALUES (?,?,?,?,?,?)').run(id, req.user.id, date, photo, null, new Date().toISOString());
        const description = db.prepare('SELECT description FROM meal_descriptions WHERE meal_id=?').get(original.id);
        if (description) db.prepare('INSERT INTO meal_descriptions VALUES (?,?)').run(id, description.description);
        for (const analysis of analyses) {
          db.prepare('INSERT INTO analyses VALUES(?,?,?,?,?,?)').run(mapped.get(analysis.id), id, analysis.instructions, analysis.description, analysis.options, analysis.created_at);
        }
        if (mapped.has(selected.analysisId)) selected.analysisId = mapped.get(selected.analysisId);
        else {
          const analysisId = randomUUID(), option = { ...selected }; delete option.analysisId; delete option.optionIndex;
          db.prepare('INSERT INTO analyses VALUES(?,?,?,?,?,?)').run(analysisId, id, '', description?.description || selected.name, JSON.stringify([option]), new Date().toISOString());
          selected.analysisId = analysisId; selected.optionIndex = 0;
        }
        db.prepare('UPDATE meals SET selected=? WHERE id=?').run(JSON.stringify(selected), id);
        db.exec('COMMIT'); committed = true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      res.status(201).json({ meal: mealData(db.prepare('SELECT * FROM meals WHERE id=?').get(id)) });
    } catch (error) {
      if (photo && !committed) await photoStorage.remove(photo).catch(() => {});
      throw error;
    }
  });
  app.get('/api/meals/:id/photo', async (req, res) => {
    const meal = ownedMeal(req);
    if (!meal.photo) throw fail(404, 'Esta comida se registró por texto.');
    try { res.type('image/jpeg').send(await photoStorage.read(meal.photo)); }
    catch (error) { if (error.code === 'ENOENT') throw fail(404, 'La foto no está disponible mientras falta el disco externo.'); throw error; }
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 2, fieldSize: 2000 } });
  app.post('/api/meals', upload.single('photo'), withSubmission(async (req, res) => {
    if (!req.user.profile) throw fail(400, 'Guardá tu configuración antes de añadir comidas.');
    if (!validDate(req.body.date)) throw fail(400, 'Fecha inválida.');
    if (!req.file) throw fail(400, 'Seleccioná una foto.');
    const id = randomUUID(), photo = `${id}.jpg`;
    let image;
    try { image = await sharp(req.file.buffer, { limitInputPixels: 40000000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); }
    catch { throw fail(400, 'No se pudo leer la imagen. Usá una foto JPG, PNG o WebP.'); }
    limits.take(req.user.id, 'food', `meal:${id}`);
    try {
      await photoStorage.write(photo, image);
      db.prepare('INSERT INTO meals VALUES (?,?,?,?,?,?)').run(id, req.user.id, req.body.date, photo, null, new Date().toISOString());
    } catch (error) { limits.release(req.user.id, 'food', `meal:${id}`); await photoStorage.remove(photo).catch(() => {}); throw error; }
    // Keep the uploaded meal even if Codex is unavailable, so analysis can be retried.
    res.status(201).json({ meal: mealData(db.prepare('SELECT * FROM meals WHERE id=?').get(id)) });
  }));
  const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0 } });
  app.post('/api/transcribe', audioUpload.single('audio'), withSubmission(async (req, res) => {
    if (!req.file) throw fail(400, 'Grabá o seleccioná un audio.');
    const started = Date.now();
    const log = (outcome, extra = {}) => logExecution('audio_transcription', { outcome, userId: req.user.id, bytes: req.file.size, mimeType: req.file.mimetype, elapsedMs: Date.now() - started, ...extra });
    log('started');
    let saved = null;
    const recordResult = async result => {
      if (!saved) return;
      try { await recordAudioResult(saved, result); log('diagnostic_result_saved'); }
      catch { log('diagnostic_result_failed'); }
    };
    try {
      saved = await captureDiagnosticAudio({ dataDir, userId: req.user.id, buffer: req.file.buffer, mimeType: req.file.mimetype, requestId: res.get('X-Request-ID') });
      if (saved) log('diagnostic_copy_saved', { file: saved });
    } catch { log('diagnostic_copy_failed'); }
    res.once('close', () => { if (!res.writableEnded) log('disconnected'); });
    try {
      const result = await transcribeAudio(req.file.buffer);
      await recordResult({ text: result.text });
      log('completed'); res.json(result);
    } catch (e) {
      e.status = e.status || 502;
      await recordResult({ errorCode: ['AUDIO_NO_SPEECH', 'AUDIO_TRANSCRIPT_TOO_LONG'].includes(e.code) ? e.code : 'TRANSCRIPTION_FAILED' });
      log('failed', { status: e.status }); throw e;
    }
  }));
  extractionQueue.register('food', async job => {
    const meal = ownedMeal({ params: { id: job.resource_id }, user: { id: job.user_id } });
    if (db.prepare('SELECT id FROM analyses WHERE id=?').get(job.id)) return { meal: mealData(meal) };
    const { instructions } = job.payload;
    const prior = db.prepare('SELECT instructions FROM analyses WHERE meal_id=? ORDER BY created_at,rowid').all(meal.id).map(a => a.instructions).filter(Boolean);
    const context = prior.length ? `Correcciones anteriores (conservar salvo contradicción explícita): ${JSON.stringify(prior.slice(-10))}. Nueva corrección: ${instructions}` : instructions;
    const result = meal.photo
      ? await photoStorage.withFile(meal.photo, file => analyzer(file, context))
      : await descriptionAnalyzer(db.prepare('SELECT description FROM meal_descriptions WHERE meal_id=?').get(meal.id)?.description || '', context);
    if (db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(job.user_id)?.enable_codex_extraction !== 1) throw fail(403, 'No tenés autorización para usar esta función. Contactá con el administrador.');
    insertAnalysis(meal.id, instructions, result, job.id);
    return { meal: mealData(meal) };
  });
  app.post('/api/meals/:id/analyze', withSubmission(async (req, res) => {
    const meal = ownedMeal(req);
    const instructions = req.body?.instructions ?? '';
    if (typeof instructions !== 'string' || instructions.length > 1500) throw fail(400, 'Las instrucciones pueden tener hasta 1500 caracteres.');
    const correction = !!db.prepare('SELECT id FROM analyses WHERE meal_id=? LIMIT 1').get(meal.id);
    const id = extractionQueue.enqueue({ userId: req.user.id, kind: 'food', resourceId: meal.id, payload: { instructions },
      key: req.get('X-Submission-ID') || randomUUID(),
      reserve: jobId => limits.take(req.user.id, correction ? 'clarification' : 'food', correction ? jobId : `meal:${meal.id}`) });
    await extractionQueue.respond(req, res, id);
  }));
  app.put('/api/meals/:id/selection', (req, res) => {
    const meal = ownedMeal(req);
    const { analysisId, optionIndex } = req.body || {};
    const analysis = typeof analysisId === 'string' && db.prepare('SELECT * FROM analyses WHERE id=? AND meal_id=?').get(analysisId, meal.id);
    const option = analysis && Number.isInteger(optionIndex) && JSON.parse(analysis.options)[optionIndex];
    if (!option) throw fail(400, 'Elegí una de las opciones recibidas.');
    db.prepare('UPDATE meals SET selected=? WHERE id=?').run(JSON.stringify({ ...option, analysisId, optionIndex }), meal.id);
    res.json({ meal: mealData(db.prepare('SELECT * FROM meals WHERE id=?').get(meal.id)) });
  });
  app.delete('/api/meals/:id', async (req, res) => {
    const meal = ownedMeal(req);
    if (extractionQueue.active(meal.id)) throw fail(409, 'Esperá a que termine el análisis para eliminar esta comida.');
    db.prepare('DELETE FROM meals WHERE id=?').run(meal.id);
    if (meal.photo) await photoStorage.remove(meal.photo).catch(() => {});
    res.json({ ok: true });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use(express.static(publicDir, { etag: true, maxAge: 0 }));
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    if (err instanceof multer.MulterError) status = 400;
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño permitido (12 MB para fotos, 8 MB para audio).' : err instanceof multer.MulterError ? 'Subí una sola foto de hasta 12 MB.' : status < 500 || status === 502 ? err.message : 'Ocurrió un error. Volvé a intentarlo.';
    if (status === 500) console.error('Request failed:', err.code || err.name);
    res.status(status).json({ error: message, ...(['CODEX_EXTRACTION_DISABLED', 'USAGE_LIMIT'].includes(err.code) ? { code: err.code } : {}) });
  });
  extractionQueue.start();
  return { app, db, photoStorage, extractionQueue };
}

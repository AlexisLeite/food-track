import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateProfile, validDate, today, withMacroPlan } from './nutrition.js';
import { analyzePhoto, analyzeDescription, validateAnalysis } from './codex.js';
import { transcribeAudio } from './audio.js';
import { summarizeMeals } from '../public/nutrition.js';
import { migrateCaloriePolicy } from './calorie-policy.js';
import { buildHistory, dateOffset, buildWeek, weekRange } from './history.js';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
export async function createApplication({ dataDir = path.resolve(process.env.DATA_DIR || 'data'), analyzer = analyzePhoto, descriptionAnalyzer = analyzeDescription, origin = process.env.APP_ORIGIN || 'http://localhost:3086', secureCookies = process.env.COOKIE_SECURE === 'true' } = {}) {
  await mkdir(path.join(dataDir, 'photos'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'foodtrack.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, profile TEXT);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meals(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, photo TEXT NOT NULL, selected TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS meals_user_date ON meals(user_id,date);
    CREATE TABLE IF NOT EXISTS analyses(id TEXT PRIMARY KEY, meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE, instructions TEXT NOT NULL, description TEXT NOT NULL, options TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meal_descriptions(meal_id TEXT PRIMARY KEY REFERENCES meals(id) ON DELETE CASCADE, description TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_goals(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, profile TEXT NOT NULL, PRIMARY KEY(user_id,date));
    PRAGMA user_version=1;`);
  // Seed the earliest known goal for existing accounts; earlier goals are unknown.
  for (const user of db.prepare('SELECT id,profile FROM users WHERE profile IS NOT NULL').all()) {
    const profile = JSON.parse(user.profile);
    db.prepare('INSERT OR IGNORE INTO profile_goals VALUES (?,?,?)').run(user.id, validDate(profile.startDate) ? profile.startDate : today(), user.profile);
  }
  await migrateCaloriePolicy(db, dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Permissions-Policy': 'camera=(self), microphone=(self)' });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (req.get('X-Foodtrack') !== '1' || (req.get('Origin') && req.get('Origin') !== origin))) return next(fail(403, 'Petición no permitida. Recargá la página.'));
    next();
  });
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
  const publicUser = user => ({ id: user.id, username: user.username, profile: user.profile ? withMacroPlan(JSON.parse(user.profile)) : null });
  const credentials = req => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || typeof password !== 'string' || password.length < 10 || password.length > 128) throw fail(400, 'Usá un usuario de 3 a 32 letras, números, puntos o guiones y una contraseña de 10 a 128 caracteres.');
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
    res.status(201).json({ user: { id, username, profile: null } });
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
    req.user = user; req.sessionHash = hash(token); next();
  });
  app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user), today: today() }));
  app.post('/api/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(req.sessionHash); res.clearCookie('foodtrack_session', { path: '/', secure: secureCookies, httpOnly: true, sameSite: 'strict' }); res.json({ ok: true }); });
  app.put('/api/profile', (req, res) => {
    let profile;
    try { profile = calculateProfile(req.body); } catch (e) { throw fail(400, e.message); }
    const encoded = JSON.stringify(profile);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET profile=? WHERE id=?').run(encoded, req.user.id);
      db.prepare('INSERT INTO profile_goals VALUES (?,?,?) ON CONFLICT(user_id,date) DO UPDATE SET profile=excluded.profile').run(req.user.id, today(), encoded);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
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
  function insertAnalysis(mealId, instructions, result) {
    validateAnalysis(result);
    db.prepare('INSERT INTO analyses(id,meal_id,instructions,description,options,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), mealId, instructions, result.description, JSON.stringify(result.options), new Date().toISOString());
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
    const goals = db.prepare('SELECT date,profile FROM profile_goals WHERE user_id=? AND date<=? ORDER BY date').all(req.user.id, end);
    const week = buildWeek({ date: req.query.date, asOf: today(), meals: weekMeals, goals, profile: req.user.profile ? JSON.parse(req.user.profile) : null });
    sendVersioned(req, res, { meals, week, total: totals.calories, macros: { protein: totals.protein, fat: totals.fat, carbs: totals.carbs, missingMeals: totals.missingMacros } });
  });
  app.get('/api/history', (req, res) => {
    const end = req.query.end || today();
    const length = req.query.days === undefined ? 7 : Number(req.query.days);
    if (!validDate(end) || ![7,30,90].includes(length)) throw fail(400, 'Elegí un período de 7, 30 o 90 días y una fecha válida.');
    const start = dateOffset(end, 1 - length);
    if (!validDate(start)) throw fail(400, 'Período inválido.');
    const rangeStart = weekRange(start).start, rangeEnd = weekRange(end).end;
    const meals = db.prepare('SELECT date,selected FROM meals WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date').all(req.user.id, rangeStart, rangeEnd);
    const goals = db.prepare('SELECT date,profile FROM profile_goals WHERE user_id=? AND date<=? ORDER BY date').all(req.user.id, rangeEnd);
    sendVersioned(req, res, buildHistory({ start, end, meals, goals, asOf: today() }));
  });
  app.post('/api/meals/describe', (req, res) => {
    if (!req.user.profile) throw fail(400, 'Guardá tu configuración antes de añadir comidas.');
    const { date, description } = req.body || {};
    if (!validDate(date)) throw fail(400, 'Fecha inválida.');
    if (typeof description !== 'string' || !description.trim() || description.length > 1500) throw fail(400, 'Describí tu comida en hasta 1500 caracteres.');
    const id = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO meals VALUES (?,?,?,?,?,?)').run(id, req.user.id, date, '', null, new Date().toISOString());
      db.prepare('INSERT INTO meal_descriptions VALUES (?,?)').run(id, description.trim());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.status(201).json({ meal: mealData(db.prepare('SELECT * FROM meals WHERE id=?').get(id)) });
  });
  app.post('/api/meals/:id/repeat', async (req, res) => {
    const original = ownedMeal(req), date = req.body?.date;
    if (!validDate(date)) throw fail(400, 'Elegí una fecha válida.');
    if (!original.selected) throw fail(409, 'Elegí una opción antes de repetir la comida.');
    const id = randomUUID(), photo = original.photo ? `${id}.jpg` : '';
    let committed = false;
    try {
      if (photo) await copyFile(path.join(dataDir, 'photos', original.photo), path.join(dataDir, 'photos', photo));
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
      if (photo && !committed) await unlink(path.join(dataDir, 'photos', photo)).catch(() => {});
      throw error;
    }
  });
  app.get('/api/meals/:id/photo', (req, res) => { const meal = ownedMeal(req); if (!meal.photo) throw fail(404, 'Esta comida se registró por texto.'); res.sendFile(path.resolve(dataDir, 'photos', meal.photo)); });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 2, fieldSize: 2000 } });
  app.post('/api/meals', upload.single('photo'), async (req, res) => {
    if (!req.user.profile) throw fail(400, 'Guardá tu configuración antes de añadir comidas.');
    if (!validDate(req.body.date)) throw fail(400, 'Fecha inválida.');
    if (!req.file) throw fail(400, 'Seleccioná una foto.');
    const id = randomUUID(), photo = `${id}.jpg`;
    let image;
    try { image = await sharp(req.file.buffer, { limitInputPixels: 40000000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); }
    catch { throw fail(400, 'No se pudo leer la imagen. Usá una foto JPG, PNG o WebP.'); }
    await writeFile(path.join(dataDir, 'photos', photo), image, { mode: 0o600 });
    db.prepare('INSERT INTO meals VALUES (?,?,?,?,?,?)').run(id, req.user.id, req.body.date, photo, null, new Date().toISOString());
    // Keep the uploaded meal even if Codex is unavailable, so analysis can be retried.
    res.status(201).json({ meal: mealData(db.prepare('SELECT * FROM meals WHERE id=?').get(id)) });
  });
  const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0 } });
  app.post('/api/transcribe', audioUpload.single('audio'), async (req, res) => {
    if (!req.file) throw fail(400, 'Grabá o seleccioná un audio.');
    try { res.json(await transcribeAudio(req.file.buffer)); }
    catch (e) { e.status = e.status || 502; throw e; }
  });
  const analyzing = new Set();
  app.post('/api/meals/:id/analyze', async (req, res) => {
    const meal = ownedMeal(req);
    const instructions = req.body?.instructions ?? '';
    if (typeof instructions !== 'string' || instructions.length > 1500) throw fail(400, 'Las instrucciones pueden tener hasta 1500 caracteres.');
    if (analyzing.has(meal.id)) throw fail(409, 'Esta foto ya se está analizando.');
    analyzing.add(meal.id);
    const analysisStarted = Date.now();
    const logAnalysis = (outcome, extra = {}) => console.info(JSON.stringify({ event: 'meal_analysis', outcome, userId: req.user.id, mealId: meal.id, source: meal.photo ? 'photo' : 'description', elapsedMs: Date.now() - analysisStarted, ...extra }));
    try {
      const prior = db.prepare('SELECT instructions FROM analyses WHERE meal_id=? ORDER BY created_at, rowid').all(meal.id).map(a => a.instructions).filter(Boolean);
      const context = prior.length ? `Correcciones anteriores (conservar salvo contradicción explícita): ${JSON.stringify(prior.slice(-10))}. Nueva corrección: ${instructions}` : instructions;
      const result = meal.photo
        ? await analyzer(path.join(dataDir, 'photos', meal.photo), context)
        : await descriptionAnalyzer(db.prepare('SELECT description FROM meal_descriptions WHERE meal_id=?').get(meal.id)?.description || '', context);
      if (!db.prepare('SELECT id FROM meals WHERE id=? AND user_id=?').get(meal.id, req.user.id)) throw fail(404, 'La comida fue eliminada.');
      insertAnalysis(meal.id, instructions, result);
      logAnalysis(result.options.length ? 'completed' : 'empty', { optionCount: result.options.length });
      res.json({ meal: mealData(db.prepare('SELECT * FROM meals WHERE id=?').get(meal.id)) });
    } catch (e) { if (!e.status) e.status = 502; logAnalysis('failed', { status: e.status, reason: ['CODEX_BUSY', 'CODEX_START_FAILED', 'CODEX_TIMEOUT', 'CODEX_EXIT_FAILED'].includes(e.code) ? e.code : 'ANALYSIS_ERROR' }); throw e; }
    finally { analyzing.delete(meal.id); }
  });
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
    if (analyzing.has(meal.id)) throw fail(409, 'Esperá a que termine el análisis para eliminar esta comida.');
    db.prepare('DELETE FROM meals WHERE id=?').run(meal.id);
    if (meal.photo) await unlink(path.join(dataDir, 'photos', meal.photo)).catch(() => {});
    res.json({ ok: true });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use(express.static(publicDir, { etag: true, maxAge: 0 }));
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    if (err instanceof multer.MulterError) status = 400;
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño permitido (12 MB para fotos, 8 MB para audio).' : err instanceof multer.MulterError ? 'Subí una sola foto de hasta 12 MB.' : status < 500 || status === 502 ? err.message : 'Ocurrió un error. Volvé a intentarlo.';
    if (status === 500) console.error('Request failed:', err.code || err.name);
    res.status(status).json({ error: message });
  });
  return { app, db };
}

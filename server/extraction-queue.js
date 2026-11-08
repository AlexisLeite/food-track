import { randomUUID, createHash } from 'node:crypto';
import { logExecution, withRequestLog } from './execution-log.js';
export const retryableExtractionError = error => error?.status === 429 || error?.status >= 500 || (!error?.status && error?.code !== 'CODEX_EXTRACTION_DISABLED');
export function createExtractionQueue(db, { runAs = (_user, callback) => callback(), retryDelays = [1000, 3000], concurrency = 3 } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS extraction_jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,resource_id TEXT NOT NULL,payload TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,created_at TEXT NOT NULL,UNIQUE(user_id,request_key));
    CREATE INDEX IF NOT EXISTS extraction_jobs_state ON extraction_jobs(state,next_at);
    UPDATE extraction_jobs SET state='queued' WHERE state='running';`);
  const handlers = new Map();
  let enabled = false, timer = null, stopped = false;
  const running = new Set();
  const get = id => db.prepare('SELECT * FROM extraction_jobs WHERE id=?').get(id);
  const permitted = userId => {
    if (db.prepare('SELECT enable_codex_extraction FROM users WHERE id=?').get(userId)?.enable_codex_extraction !== 1) throw Object.assign(new Error('No tenés autorización para usar esta función. Contactá con el administrador.'), { status: 403, code: 'CODEX_EXTRACTION_DISABLED' });
  };
  const kick = () => {
    if (!enabled || stopped || running.size >= concurrency || !db.isOpen) return;
    clearTimeout(timer);
    const job = db.prepare("SELECT * FROM extraction_jobs WHERE state='queued' AND next_at<=? ORDER BY rowid LIMIT 1").get(Date.now());
    if (!job) {
      const next = db.prepare("SELECT MIN(next_at) AS at FROM extraction_jobs WHERE state='queued'").get().at;
      if (next !== null) { timer = setTimeout(kick, Math.max(1, next - Date.now())); timer.unref(); }
      return;
    }
    db.prepare("UPDATE extraction_jobs SET state='running',attempts=attempts+1 WHERE id=?").run(job.id);
    job.attempts++;
    const task = Promise.resolve().then(() => withRequestLog(`extraction:${job.id}`, () => runAs(job.user_id, async () => {
      permitted(job.user_id);
      const handler = handlers.get(job.kind);
      if (!handler) throw Object.assign(new Error('Tipo de extracción no disponible.'), { status: 400 });
      logExecution('extraction_queue', { phase: 'started', jobId: job.id, userId: job.user_id, attempt: job.attempts });
      const result = await handler({ ...job, payload: JSON.parse(job.payload) });
      permitted(job.user_id);
      db.prepare("UPDATE extraction_jobs SET state='completed',result=?,error=NULL WHERE id=?").run(JSON.stringify(result), job.id);
      logExecution('extraction_queue', { phase: 'completed', jobId: job.id, userId: job.user_id, attempt: job.attempts });
    }))).catch(error => {
      const retry = retryableExtractionError(error) && job.attempts <= retryDelays.length;
      const details = { error: error.message || 'No se pudo analizar. Reintentá.', status: error.status || 502, code: error.code };
      db.prepare('UPDATE extraction_jobs SET state=?,next_at=?,error=? WHERE id=?').run(retry ? 'queued' : 'failed', retry ? Date.now() + retryDelays[job.attempts - 1] : 0, JSON.stringify(details), job.id);
      logExecution('extraction_queue', { phase: retry ? 'retrying' : 'failed', jobId: job.id, userId: job.user_id, attempt: job.attempts, status: details.status });
    }).finally(() => { running.delete(task); kick(); });
    running.add(task); kick();
  };
  const view = row => ({ job: { id: row.id, state: row.state, attempts: row.attempts, ...(row.state === 'queued' ? { position: db.prepare("SELECT COUNT(*) AS n FROM extraction_jobs WHERE state IN ('queued','running') AND rowid<=(SELECT rowid FROM extraction_jobs WHERE id=?)").get(row.id).n } : {}) }, ...(row.result ? { result: JSON.parse(row.result) } : {}), ...(row.state === 'failed' ? JSON.parse(row.error) : {}) });
  return {
    register(kind, handler) { handlers.set(kind, handler); },
    start() { enabled = true; kick(); },
    async stop() { stopped = true; clearTimeout(timer); await Promise.allSettled([...running]); },
    active(resourceId) { return !!db.prepare("SELECT 1 FROM extraction_jobs WHERE resource_id=? AND state IN ('queued','running')").get(resourceId); },
    enqueue({ userId, kind, resourceId, payload, key = randomUUID(), reserve = () => {} }) {
      permitted(userId);
      const encoded = JSON.stringify(payload), fingerprint = createHash('sha256').update(JSON.stringify([kind, resourceId, encoded])).digest('hex');
      const previous = db.prepare('SELECT * FROM extraction_jobs WHERE user_id=? AND request_key=?').get(userId, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('Este hash pertenece a otro envío.'), { status: 409 });
        // Explicitly resending a failed transient request starts another bounded batch.
        if (previous.state === 'failed' && retryableExtractionError(JSON.parse(previous.error))) { db.prepare("UPDATE extraction_jobs SET state='queued',attempts=0,next_at=0,error=NULL WHERE id=?").run(previous.id); kick(); }
        return previous.id;
      }
      if (this.active(resourceId)) throw Object.assign(new Error('Este registro ya tiene un análisis pendiente.'), { status: 409 });
      const id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        reserve(id);
        db.prepare("INSERT INTO extraction_jobs(id,user_id,kind,resource_id,payload,request_key,fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)").run(id,userId,kind,resourceId,encoded,key,fingerprint,new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      kick(); return id;
    },
    retry(id, userId) {
      const row = get(id);
      if (row?.user_id === userId && row.state === 'failed' && retryableExtractionError(JSON.parse(row.error))) {
        permitted(userId);
        db.prepare("UPDATE extraction_jobs SET state='queued',attempts=0,next_at=0,error=NULL WHERE id=?").run(id); kick();
      }
    },
    read(id, userId) { const row = get(id); if (!row || row.user_id !== userId) throw Object.assign(new Error('No se encontró el envío.'), { status: 404 }); permitted(userId); return view(row); },
    async respond(req, res, id, status = 200) {
      if (req.get('Prefer') === 'respond-async') return res.status(202).json(this.read(id, req.user.id));
      while (db.isOpen) {
        const data = this.read(id, req.user.id);
        if (data.job.state === 'completed') return res.status(status).json(data.result);
        if (data.job.state === 'failed') throw Object.assign(new Error(data.error), { status: data.status, code: data.code });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  };
}

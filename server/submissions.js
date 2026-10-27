import { createHash } from 'node:crypto';

// Persist successful replies before sending them. A lost reply can be retried without
// creating another meal or charging another extraction, including after a restart.
export function submissionHandler(db, { authorizeReplay = () => {} } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS submission_receipts(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submission_id TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status INTEGER NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(user_id, submission_id))`);
  const active = new Set();
  return handler => async (req, res) => {
    const receipt = submissionReceipt(db, req);
    if (!receipt) return handler(req, res);
    const { id, key } = receipt;
    if (receipt.response) { authorizeReplay(req); return res.status(receipt.status).json(receipt.response); }
    if (active.has(key)) throw Object.assign(new Error('El envío anterior todavía se está procesando. Reintentá en unos instantes.'), { status: 409 });
    active.add(key);
    const original = res.json;
    res.json = function (data) {
      if (this.statusCode >= 200 && this.statusCode < 300) { data = { ...data, submissionHash: id }; receipt.save(this.statusCode, data); }
      return original.call(this, data);
    };
    try { return await handler(req, res); }
    finally { active.delete(key); res.json = original; }
  };
}

export function submissionReceipt(db, req) {
  const id = req.get('X-Submission-ID');
  if (!id) return null;
  if (!/^[a-f0-9]{64}$/.test(id)) throw Object.assign(new Error('Hash de envío inválido.'), { status: 400 });
  const fingerprint = createHash('sha256').update(JSON.stringify(req.body || {})).update(req.file?.buffer || '').digest('hex');
  const previous = db.prepare('SELECT * FROM submission_receipts WHERE user_id=? AND submission_id=?').get(req.user.id, id);
  if (previous && (previous.path !== req.path || previous.fingerprint !== fingerprint)) throw Object.assign(new Error('Este hash pertenece a otro envío.'), { status: 409 });
  return {
    id, key: `${req.user.id}:${id}`, status: previous?.status,
    response: previous ? JSON.parse(previous.response) : null,
    save: (status, response) => db.prepare('INSERT INTO submission_receipts VALUES(?,?,?,?,?,?)').run(req.user.id, id, req.path, fingerprint, status, JSON.stringify(response))
  };
}

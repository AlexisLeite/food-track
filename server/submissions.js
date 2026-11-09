import { createHash } from 'node:crypto';

// Persist replies before sending them, including with asynchronous PostgreSQL I/O.
export function submissionHandler(db, { authorizeReplay = () => {} } = {}) {
  const active = new Set();
  return handler => async (req, res) => {
    const id = req.get('X-Submission-ID'), key = `${req.user.id}:${id}`;
    if (!id) return handler(req, res);
    if (active.has(key)) throw Object.assign(new Error('El envío anterior todavía se está procesando. Reintentá en unos instantes.'), { status: 409 });
    active.add(key);
    const original = res.json;
    let captured;
    try {
      const receipt = await submissionReceipt(db, req);
      if (receipt.response) { await authorizeReplay(req, receipt.response); return res.status(receipt.status).json(receipt.response); }
      res.json = function(data) { captured = data; return this; };
      await handler(req, res);
      if (captured !== undefined) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          captured = { ...captured, submissionHash: receipt.id };
          await receipt.save(res.statusCode, captured);
        }
        original.call(res, captured);
      }
    } finally { active.delete(key); res.json = original; }
  };
}

export async function submissionReceipt(db, req) {
  const id = req.get('X-Submission-ID');
  if (!id) return null;
  if (!/^[a-f0-9]{64}$/.test(id)) throw Object.assign(new Error('Hash de envío inválido.'), { status: 400 });
  const fingerprint = createHash('sha256').update(JSON.stringify(req.body || {})).update(req.file?.buffer || '').digest('hex');
  const previous = await db.prepare('SELECT * FROM submission_receipts WHERE user_id=? AND submission_id=?').get(req.user.id, id);
  if (previous && (previous.path !== req.path || previous.fingerprint !== fingerprint)) throw Object.assign(new Error('Este hash pertenece a otro envío.'), { status: 409 });
  return {
    id, key: `${req.user.id}:${id}`, status: previous?.status,
    response: previous ? JSON.parse(previous.response) : null,
    save: (status, response) => db.prepare('INSERT INTO submission_receipts VALUES(?,?,?,?,?,?)').run(req.user.id, id, req.path, fingerprint, status, JSON.stringify(response))
  };
}

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
  const path = process.env.FOODTRACK_DB
    ? resolve(process.env.FOODTRACK_DB)
    : resolve(root, process.env.DATA_DIR || 'data', 'foodtrack.sqlite');
  if (!existsSync(path)) throw Error('La base no existe; no se creará una base vacía.');
  let password = '';
  for await (const chunk of process.stdin) {
    password += chunk.toString('utf8');
    if (Buffer.byteLength(password) > 4096) throw Error('Contraseña demasiado larga.');
  }
  if (password.length < 12 || password.length > 128)
    throw Error('Usá una contraseña de 12 a 128 caracteres.');
  const salt = randomBytes(16).toString('hex');
  const encoded = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  password = '';
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=10000');
    const user = db.prepare('SELECT id FROM users WHERE username=?').get('alexis');
    if (!user) throw Error('No existe el usuario alexis.');
    const snapshot = `${path}.before-password-${Date.now()}.sqlite`;
    db.prepare('VACUUM INTO ?').run(snapshot);
    chmodSync(snapshot, 0o600);
    const check = new DatabaseSync(snapshot, { readOnly: true });
    try {
      if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
        throw Error('El respaldo no superó integrity_check; no se cambió la contraseña.');
    } finally { check.close(); }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET password=? WHERE id=?').run(encoded, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log('Contraseña de alexis actualizada. Sus sesiones anteriores fueron cerradas.');
    console.log(`Respaldo previo: ${snapshot}`);
  } finally { db.close(); }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

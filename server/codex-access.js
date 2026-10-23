import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { backup } from 'node:sqlite';

export async function migrateCodexAccess(db, dataDir) {
  if (db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'enable_codex_extraction')) return;
  const directory = join(dataDir, 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await backup(db, join(directory, `before-codex-access-${Date.now()}.sqlite`));
  db.exec('ALTER TABLE users ADD COLUMN enable_codex_extraction INTEGER NOT NULL DEFAULT 0 CHECK(enable_codex_extraction IN (0,1))');
}

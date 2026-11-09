// SQLite is retained only as a fixture for legacy migration regression tests.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createApplication as application } from '../../server/app.js';
import { migrateCodexAccess } from '../../server/codex-access.js';
import { migrateProfileVersions } from '../../server/profile-versions.js';
import { migrateCaloriePolicy } from '../../server/calorie-policy.js';
export async function createApplication(options) {
  const { dataDir } = options;
  const db = new DatabaseSync(join(dataDir, 'foodtrack.sqlite'));
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
  db.exec(`CREATE TABLE IF NOT EXISTS submission_receipts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,submission_id TEXT NOT NULL,path TEXT NOT NULL,fingerprint TEXT NOT NULL,status INTEGER NOT NULL,response TEXT NOT NULL,PRIMARY KEY(user_id,submission_id))`);
  try {
    const result = await application({ ...options, database: db });
    const close = db.close.bind(db);
    db.close = async () => { await result.extractionQueue.stop(); close(); };
    return result;
  }
  catch (error) { db.close(); throw error; }
}

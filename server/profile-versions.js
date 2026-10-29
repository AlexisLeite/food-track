import { mkdir, chmod } from 'node:fs/promises';
import { backup } from 'node:sqlite';
import path from 'node:path';
import { today, validDate } from './nutrition.js';

// Never replace old versions, including multiple edits made on the same date.
// Keep the legacy table intact so its original records remain recoverable.
export async function migrateProfileVersions(db, dataDir) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_versions'").get();
  if (exists) return;
  const directory = path.join(dataDir, 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshot = path.join(directory, `before-profile-versions-${Date.now()}.sqlite`);
  await backup(db, snapshot);
  await chmod(snapshot, 0o600);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE profile_versions(
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL, profile TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX profile_versions_user_date ON profile_versions(user_id,date,id);
      INSERT INTO profile_versions(user_id,date,profile,created_at)
        SELECT user_id,date,profile,date||'T00:00:00.000Z' FROM profile_goals ORDER BY date,rowid;
      CREATE VIEW profile_timeline AS
        SELECT user_id,date,profile FROM profile_versions v
          WHERE id=(SELECT MAX(id) FROM profile_versions latest WHERE latest.user_id=v.user_id AND latest.date=v.date)
        UNION ALL
        SELECT user_id,date,profile FROM profile_goals legacy
          WHERE NOT EXISTS(SELECT 1 FROM profile_versions v WHERE v.user_id=legacy.user_id AND v.date=legacy.date);`);
    for (const user of db.prepare('SELECT id,profile FROM users WHERE profile IS NOT NULL').all()) {
      if (db.prepare('SELECT 1 FROM profile_versions WHERE user_id=?').get(user.id)) continue;
      const profile = JSON.parse(user.profile);
      appendProfileVersion(db, user.id, user.profile, validDate(profile.startDate) ? profile.startDate : today());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function appendProfileVersion(db, userId, profile, date = today()) {
  const result = db.prepare('INSERT INTO profile_versions(user_id,date,profile,created_at) VALUES(?,?,?,?)').run(userId, date, profile, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

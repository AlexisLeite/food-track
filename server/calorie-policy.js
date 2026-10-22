import { mkdir } from 'node:fs/promises';
import { backup } from 'node:sqlite';
import path from 'node:path';
import { caloriePolicyVersion } from '../public/nutrition.js';
import { applyCaloriePolicy, today } from './nutrition.js';

export async function migrateCaloriePolicy(db, dataDir, date = today()) {
  const updates = db.prepare('SELECT id,profile FROM users WHERE profile IS NOT NULL').all()
    .filter(user => JSON.parse(user.profile).caloriePolicyVersion !== caloriePolicyVersion)
    .map(user => ({ id: user.id, profile: JSON.stringify(applyCaloriePolicy(JSON.parse(user.profile))) }));
  if (!updates.length) return 0;
  const directory = path.join(dataDir, 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await backup(db, path.join(directory, `before-calorie-policy-${caloriePolicyVersion}-${Date.now()}.sqlite`));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const user of updates) {
      db.prepare('UPDATE users SET profile=? WHERE id=?').run(user.profile, user.id);
      db.prepare('INSERT OR REPLACE INTO profile_goals VALUES(?,?,?)').run(user.id, date, user.profile);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return updates.length;
}

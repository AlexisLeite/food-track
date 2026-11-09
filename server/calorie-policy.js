import { transaction } from './database.js';
import { appendProfileVersion } from './profile-versions.js';
import { mkdir } from 'node:fs/promises';
import { backup } from 'node:sqlite';
import path from 'node:path';
import { caloriePolicyVersion } from '../public/nutrition.js';
import { applyCaloriePolicy, today } from './nutrition.js';
export async function migrateCaloriePolicy(db, dataDir, date = today()) {
  const updates = (await db.prepare('SELECT id,profile FROM users WHERE profile IS NOT NULL').all()).filter(user => JSON.parse(user.profile).caloriePolicyVersion !== caloriePolicyVersion).map(user => ({
    id: user.id,
    profile: JSON.stringify(applyCaloriePolicy(JSON.parse(user.profile)))
  }));
  if (!updates.length) return 0;
  const directory = path.join(dataDir, 'backups');
  await mkdir(directory, {
    recursive: true,
    mode: 0o700
  });
  await backup(db, path.join(directory, `before-calorie-policy-${caloriePolicyVersion}-${Date.now()}.sqlite`));
  await transaction(db, async () => {
    for (const user of updates) {
      await db.prepare('UPDATE users SET profile=? WHERE id=?').run(user.profile, user.id);
      if (await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_versions'").get()) await appendProfileVersion(db, user.id, user.profile, date);else await db.prepare('INSERT OR REPLACE INTO profile_goals VALUES(?,?,?)').run(user.id, date, user.profile);
    }
  });
  return updates.length;
}

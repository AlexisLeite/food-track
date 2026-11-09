import { transaction } from './database.js';
import { today } from './nutrition.js';
import { dateOffset } from './history.js';
export const usageLimits = Object.freeze({
  food: 56,
  workout: 56,
  clarification: 168,
  chat: 5
});
export function usagePeriod(kind, date = today()) {
  if (kind === 'chat') return date;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dateOffset(date, -((weekday + 6) % 7));
}
const names = {
  food: 'comidas',
  workout: 'entrenamientos',
  clarification: 'aclaraciones de comidas y entrenamientos',
  chat: 'mensajes del asistente'
};
export async function installUsageLimits(db, clock = today) {
  if (db.dialect !== 'postgresql') {
    await db.exec(`CREATE TABLE IF NOT EXISTS usage_reservations(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, period TEXT NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,kind,request_key));
    CREATE INDEX IF NOT EXISTS usage_reservations_period ON usage_reservations(user_id,kind,period);
    CREATE TABLE IF NOT EXISTS usage_limits_meta(id INTEGER PRIMARY KEY);`);
    const insert = db.prepare('INSERT OR IGNORE INTO usage_reservations VALUES(?,?,?,?,?)');
    // Count existing work once; calendar dates and later deletions never refund usage.
    if (!(await db.prepare('SELECT id FROM usage_limits_meta WHERE id=1').get())) {
      await transaction(db, async () => {
        const add = async (user, kind, key, timestamp) => {
          const date = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Montevideo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          }).format(new Date(timestamp));
          await insert.run(user, kind, usagePeriod(kind, date), key, timestamp);
        };
        const seen = new Set();
        for (const row of await db.prepare('SELECT a.id,a.meal_id,a.created_at,m.created_at AS meal_created,m.user_id FROM analyses a JOIN meals m ON m.id=a.meal_id ORDER BY a.created_at,a.rowid').all()) {
          // Repeating a meal copies earlier analyses without invoking AI.
          if (row.created_at < row.meal_created) continue;
          const kind = seen.has(row.meal_id) ? 'clarification' : 'food';
          seen.add(row.meal_id);
          await add(row.user_id, kind, kind === 'food' ? `meal:${row.meal_id}` : `legacy:${row.id}`, row.created_at);
        }
        if (await db.prepare("SELECT name FROM sqlite_master WHERE name='workouts'").get()) for (const row of await db.prepare('SELECT id,user_id,created_at FROM workouts').all()) await add(row.user_id, 'workout', `legacy:${row.id}`, row.created_at);
        for (const row of await db.prepare("SELECT id,user_id,created_at FROM token_usage WHERE source='chat'").all()) await add(row.user_id, 'chat', `legacy:${row.id}`, row.created_at);
        await db.exec('INSERT INTO usage_limits_meta VALUES(1)');
      });
    }
  }
  const insert = db.prepare('INSERT INTO usage_reservations VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING');
  return {
    async snapshot(userId) {
      const date = clock();
      const budgets = Object.fromEntries(await Promise.all(Object.entries(usageLimits).map(async ([kind, limit]) => {
        const period = usagePeriod(kind, date);
        const used = (await db.prepare('SELECT COUNT(*) AS n FROM usage_reservations WHERE user_id=? AND kind=? AND period=?').get(userId, kind, period)).n;
        const renewsOn = dateOffset(period, kind === 'chat' ? 1 : 7);
        return [kind, {
          limit,
          used,
          remaining: Math.max(0, limit - used),
          periodStart: period,
          renewsAt: `${renewsOn}T00:00:00-03:00`
        }];
      })));
      return {
        timeZone: 'America/Montevideo',
        budgets
      };
    },
    async release(userId, kind, key) {
      await db.prepare('DELETE FROM usage_reservations WHERE user_id=? AND kind=? AND request_key=?').run(userId, kind, key);
    },
    async take(userId, kind, key) {
      return await transaction(db, async () => {
        if (!Object.hasOwn(usageLimits, kind)) throw new Error('Unknown usage kind');
        if (await db.prepare('SELECT 1 FROM usage_reservations WHERE user_id=? AND kind=? AND request_key=?').get(userId, kind, key)) return;
        const period = usagePeriod(kind, clock());
        const used = (await db.prepare('SELECT COUNT(*) AS n FROM usage_reservations WHERE user_id=? AND kind=? AND period=?').get(userId, kind, period)).n;
        if (used >= usageLimits[kind]) throw Object.assign(new Error(`Alcanzaste el límite de ${usageLimits[kind]} ${names[kind]} ${kind === 'chat' ? 'por día. Se renueva a las 00:00 de Uruguay.' : 'por semana. Se renueva el lunes a las 00:00 de Uruguay.'}`), {
          status: 429,
          code: 'USAGE_LIMIT'
        });
        await insert.run(userId, kind, period, key, new Date().toISOString());
      });
    }
  };
}

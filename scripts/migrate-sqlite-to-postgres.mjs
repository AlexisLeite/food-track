import { DatabaseSync, backup } from 'node:sqlite';
import { openDatabase } from '../server/database.js';
import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const tables = ['users','sessions','meals','analyses','meal_descriptions','profile_goals','submission_receipts','profile_versions','workouts','token_usage','token_usage_meta','usage_reservations','usage_limits_meta','extraction_jobs','workout_clarifications'];
const orderedTables = ['analyses','extraction_jobs','workout_clarifications'];
const digest = rows => createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');

export async function snapshotSqlite(source, target) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
  await chmod(target, 0o600);
  return target;
}

export async function migrateSqlite({ source, databaseUrl, verifyOnly = false }) {
  const sqlite = new DatabaseSync(source, { readOnly: true });
  let db;
  try {
    if (sqlite.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Source integrity check failed');
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Source foreign key check failed');
    const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    if (names.length !== tables.length || names.some(name => !tables.includes(name))) throw new Error('Unexpected source schema: update migration before continuing');
    db = await openDatabase(databaseUrl);
    const report = await db.transaction(async () => {
      const result = {};
      for (const table of tables) {
        const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
        const quoted = columns.map(c => `"${c}"`).join(',');
        const rows = sqlite.prepare(`SELECT ${orderedTables.includes(table) ? 'rowid AS ordinal,' : ''}${quoted} FROM "${table}" ORDER BY rowid`).all();
        if (!verifyOnly) {
          if ((await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()).n) throw new Error(`Destination ${table} is not empty; import refused`);
          for (const row of rows) {
            // Prisma create uses the schema, preserves all original values, and
            // copies SQLite rowid into an explicit ordering column where needed.
            await db.prismaDelegate(table).create({ data: { ...row } });
          }
        }
        const original = rows.map(({ ordinal, ...row }) => row);
        const target = (await db.prepare(`SELECT ${quoted} FROM "${table}"`).all()).map(row => Object.fromEntries(columns.map(c => [c, row[c]])));
        const expected = digest(original), actual = digest(target);
        if (rows.length !== target.length || expected !== actual) throw new Error(`Data verification failed for ${table}`);
        if (orderedTables.includes(table)) {
          const ordinals = await db.prepare(`SELECT id,ordinal FROM "${table}" ORDER BY ordinal`).all();
          if (JSON.stringify(ordinals) !== JSON.stringify(rows.map(r => ({ id:r.id, ordinal:r.ordinal })))) throw new Error(`Order verification failed for ${table}`);
        }
        result[table] = { rows: rows.length, sha256: expected };
      }
      const sourceTimeline = sqlite.prepare('SELECT user_id,date,profile FROM profile_timeline ORDER BY user_id,date').all();
      const targetTimeline = await db.prepare('SELECT user_id,date,profile FROM profile_timeline ORDER BY user_id,date').all();
      if (digest(sourceTimeline) !== digest(targetTimeline)) throw new Error('Historical profile timeline differs');
      if (!verifyOnly) {
        for (const [table, column] of [['profile_versions','id'],...orderedTables.map(table => [table,'ordinal'])]) {
          await db.exec(`SELECT setval(pg_get_serial_sequence('${table}','${column}'),COALESCE(MAX("${column}"),1),MAX("${column}") IS NOT NULL) FROM "${table}"`);
        }
      }
      return result;
    });
    return { verified: true, mode: verifyOnly ? 'verify' : 'import', tables: report };
  } finally { sqlite.close(); await db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const source = process.argv[2];
    if (!source) throw new Error('Usage: node --env-file=.env scripts/migrate-sqlite-to-postgres.mjs SNAPSHOT.sqlite [--verify-only]');
    const result = await migrateSqlite({ source, databaseUrl: process.env.DATABASE_URL, verifyOnly: process.argv.includes('--verify-only') });
    await writeFile(source+'.postgresql-verification.json', JSON.stringify(result,null,2), { mode:0o600 });
    console.log(JSON.stringify(result,null,2));
  } catch (error) { console.error('Migration failed:', error.code || error.message); process.exitCode=1; }
}

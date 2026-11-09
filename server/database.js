import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { AsyncLocalStorage } from 'node:async_hooks';

function plain(value) {
  if (typeof value === 'bigint') {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error('Database integer exceeds JavaScript precision');
    return n;
  }
  if (Prisma.Decimal.isDecimal(value)) return value.toNumber();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plain(v)]));
  return value;
}

// Keep the existing parameterized SQL queries while Prisma owns connections,
// transactions and schema migrations. Only placeholders outside SQL literals change.
export function postgresParameters(sql) {
  let quote = false, index = 0, result = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (quote && sql[i + 1] === "'") { result += "''"; i++; continue; }
      quote = !quote;
    }
    result += ch === '?' && !quote ? `$${++index}` : ch;
  }
  return result;
}

export async function openDatabase(url = process.env.DATABASE_URL) {
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must point to PostgreSQL; SQLite is only a migration source.');
  const parsed = new URL(url), schema = parsed.searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  parsed.searchParams.delete('schema');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: parsed.toString(), application_name: 'foodtrack', max: 8, connectionTimeoutMillis: 10000, options: `-c search_path=${schema}` }, { schema }) });
  const context = new AsyncLocalStorage();
  const client = () => context.getStore() || prisma;
  const query = async (sql, args) => plain(await client().$queryRawUnsafe(postgresParameters(sql), ...args));
  const db = {
    dialect: 'postgresql', prisma, isOpen: true,
    prismaDelegate(table) { return client()[table]; },
    prepare(sql) {
      return {
        all: (...args) => query(sql, args),
        get: async (...args) => (await query(sql, args))[0],
        run: async (...args) => {
          if (/^INSERT INTO profile_versions\b/i.test(sql)) {
            const rows = await query(sql + ' RETURNING id', args);
            return { changes: rows.length, lastInsertRowid: rows[0]?.id };
          }
          return { changes: await client().$executeRawUnsafe(postgresParameters(sql), ...args) };
        },
      };
    },
    async exec(sql) { return client().$executeRawUnsafe(sql); },
    async transaction(callback) {
      if (context.getStore()) return callback();
      return prisma.$transaction(tx => context.run(tx, async () => {
        // Serialize short write transactions, including quota checks and job creation.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(702061109::bigint)::text`;
        return callback();
      }), { maxWait: 15000, timeout: 30000 });
    },
    async close() { await prisma.$disconnect(); db.isOpen = false; },
  };
  try { await prisma.$connect(); } catch (error) { await prisma.$disconnect(); throw error; }
  return db;
}

const legacyTransactions = new AsyncLocalStorage();
const legacyWriters = new WeakMap();

// Legacy SQLite fixtures and migration helpers share transaction semantics.
export async function transaction(db, callback) {
  if (db.transaction) return db.transaction(callback);
  if (legacyTransactions.getStore() === db) return callback();
  const previous = legacyWriters.get(db) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  legacyWriters.set(db, current);
  await previous;
  try {
    if (db.isTransaction) return await legacyTransactions.run(db, callback);
    db.exec('BEGIN IMMEDIATE');
    try { const result = await legacyTransactions.run(db, callback); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { release(); }
}

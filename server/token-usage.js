import { weeklyTokenCapacity, tokenSpeedMultiplier, tokenModelWeight } from './usage-config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { today } from './nutrition.js';
import { dateOffset } from './history.js';

const tracking = new AsyncLocalStorage();
export const canViewStatistics = user => user?.username === 'alexis';
export const withTokenTracking = (store, callback) => tracking.run(store, callback);
export function normalizeTokenUsage(value) {
  if (!value) return null;
  const input = value.input_tokens ?? value.inputTokens;
  const output = value.output_tokens ?? value.outputTokens;
  const cached = value.cached_input_tokens ?? value.cachedInputTokens ?? 0;
  const reasoning = value.reasoning_output_tokens ?? value.reasoningOutputTokens ?? 0;
  if (![input, output, cached, reasoning, input + output].every(n => Number.isSafeInteger(n) && n >= 0) || cached > input || reasoning > output) return null;
  // Cached input is already in input; reasoning is already in output.
  return { input, output, cached, reasoning, total: input + output };
}
export function startTokenExecution(source, speed = 'standard', model = 'gpt-6.1-sol') {
  const store = tracking.getStore(), id = randomUUID();
  let usage = null, status = 'running';
  const save = () => store?.record({ id, source, speed, model, usage, status });
  save();
  return {
    report(value, additive = false) {
      const next = normalizeTokenUsage(value);
      if (!next) return;
      usage = additive && usage ? Object.fromEntries(Object.keys(next).map(key => [key, usage[key] + next[key]])) : next;
      save();
    },
    finish(nextStatus) { status = nextStatus; save(); }
  };
}
export function installTokenUsage(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
    input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS token_usage_date_user ON token_usage(date,user_id);
  CREATE TABLE IF NOT EXISTS token_usage_meta (id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL);
  UPDATE token_usage SET status='interrupted' WHERE status='running';`);
  if (!db.prepare('PRAGMA table_info(token_usage)').all().some(c => c.name === 'speed')) {
    db.exec("ALTER TABLE token_usage ADD COLUMN speed TEXT NOT NULL DEFAULT 'standard' CHECK(speed IN ('standard','fast','ultrafast')); UPDATE token_usage SET speed='fast' WHERE source IN ('food','photo')");
  }
  if (!db.prepare('PRAGMA table_info(token_usage)').all().some(c => c.name === 'model')) {
    db.exec("ALTER TABLE token_usage ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-6.1-sol'");
  }
  db.prepare('INSERT OR IGNORE INTO token_usage_meta VALUES(1,?)').run(new Date().toISOString());
  const insert = db.prepare(`INSERT INTO token_usage(id,user_id,date,source,status,input_tokens,output_tokens,cached_tokens,reasoning_tokens,total_tokens,created_at,speed,model) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    status=excluded.status,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
    cached_tokens=excluded.cached_tokens,reasoning_tokens=excluded.reasoning_tokens,total_tokens=excluded.total_tokens`);
  return userId => ({ record({ id, source, speed = 'standard', model = 'gpt-6.1-sol', usage, status }) {
    insert.run(id,userId,today(),source,status,usage?.input ?? null,usage?.output ?? null,usage?.cached ?? null,usage?.reasoning ?? null,usage?.total ?? null,new Date().toISOString(),speed,model);
  } });
}
export function tokenStatistics(db, days = 30) {
  const end = today(), start = dateOffset(end, 1 - days);
  const startedAt = db.prepare('SELECT started_at FROM token_usage_meta WHERE id=1').get().started_at;
  const trackingDate = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(startedAt));
  const from = start > trackingDate ? start : trackingDate;
  const modelFactor = key => `CASE model ${Object.entries(tokenModelWeight).map(([model, weight]) => `WHEN '${model}' THEN ${weight[key]}`).join(' ')} ELSE 1 END`;
  const percentage = `COALESCE(SUM(100.0 * ((input_tokens-cached_tokens)*(${modelFactor('input')})/${weeklyTokenCapacity.input}.0 + cached_tokens*(${modelFactor('cached')})/${weeklyTokenCapacity.cached}.0 + output_tokens*(${modelFactor('output')})/${weeklyTokenCapacity.output}.0) * CASE speed WHEN 'fast' THEN ${tokenSpeedMultiplier.fast} WHEN 'ultrafast' THEN ${tokenSpeedMultiplier.ultrafast} ELSE ${tokenSpeedMultiplier.standard} END),0)`;
  const sums = `COALESCE(SUM(input_tokens),0) AS input,COALESCE(SUM(output_tokens),0) AS output,COALESCE(SUM(cached_tokens),0) AS cached,COALESCE(SUM(reasoning_tokens),0) AS reasoning,COALESCE(SUM(total_tokens),0) AS total,COUNT(*) AS executions,COALESCE(SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END),0) AS unreported,${percentage} AS weeklyPercent`;
  const byDate = new Map(db.prepare(`SELECT date,${sums} FROM token_usage WHERE date BETWEEN ? AND ? GROUP BY date`).all(from,end).map(row => [row.date,row]));
  const daily = [];
  for (let date=from; date<=end; date=dateOffset(date,1)) daily.push(byDate.get(date) || {date,input:0,output:0,cached:0,reasoning:0,total:0,executions:0,unreported:0,weeklyPercent:0});
  const topUsers = db.prepare(`SELECT users.username,${sums.replaceAll('input_tokens','u.input_tokens').replaceAll('output_tokens','u.output_tokens').replaceAll('cached_tokens','u.cached_tokens').replaceAll('reasoning_tokens','u.reasoning_tokens').replaceAll('total_tokens','u.total_tokens')} FROM token_usage u JOIN users ON users.id=u.user_id WHERE u.date BETWEEN ? AND ? GROUP BY users.id HAVING SUM(u.total_tokens)>0 ORDER BY weeklyPercent DESC,users.username LIMIT 3`).all(from,end);
  return { startedAt, start:from, end, days, quota: { estimated:true, model: 'mixed', referenceModel: 'gpt-6.1-sol', modelWeight: tokenModelWeight, plan: 'Pro US$200', windowDays:7, capacity:weeklyTokenCapacity, speedMultiplier:tokenSpeedMultiplier }, totals:db.prepare(`SELECT ${sums} FROM token_usage WHERE date BETWEEN ? AND ?`).get(from,end), daily, topUsers };
}

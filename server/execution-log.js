import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const context = new AsyncLocalStorage();
export const withRequestLog = (requestId, callback) => context.run({ requestId }, callback);
export function logExecution(event, fields) {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, ...context.getStore(), ...fields }));
}
export function executionLogger(event, fields = {}) {
  const executionId = randomUUID(), started = Date.now();
  return (phase, extra = {}) => logExecution(event, { executionId, ...fields, phase, elapsedMs: Date.now() - started, ...extra });
}

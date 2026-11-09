import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { executionLogger } from './execution-log.js';

const unavailable = () => Object.assign(new Error('Se interrumpió la conexión con Codex. Volvé a intentarlo.'), { code: 'CODEX_EXIT_FAILED' });
const disabled = ['shell_tool', 'unified_exec', 'shell_snapshot', 'code_mode',
  'apply_patch_freeform', 'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2',
  'browser_use', 'computer_use', 'view_image', 'image_generation', 'memories', 'skill_search',
  'workspace_dependencies', 'remote_plugin', 'goals', 'sleep_tool', 'tool_suggest',
  'default_mode_request_user_input'];

// One transport, separate ephemeral threads. No request may kill another user's turn.
export class CodexServer {
  constructor() {
    this.connection = null;
    this.starting = null;
    this.stopped = false;
    this.keepAlive = false;
    this.restartTimer = null;
    this.restartDelay = 1000;
  }
  start() {
    this.keepAlive = true;
    this.stopped = false;
    return this.ready();
  }
  ready() {
    if (this.stopped) return Promise.reject(unavailable());
    if (this.starting) return this.starting;
    if (this.connection?.initialized) return Promise.resolve(this.connection);
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.starting = this.connect().finally(() => { this.starting = null; });
    return this.starting;
  }
  scheduleRestart() {
    if (!this.keepAlive || this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(delay * 2, 30000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ready().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }
  async connect() {
    const log = executionLogger('codex_server');
    let dir, connection;
    try {
      dir = await mkdtemp(join(tmpdir(), 'foodtrack-codex-server-'));
      // Load only authentication, never personal rules, MCPs or plugins.
      await copyFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(dir, 'auth.json'));
      // Web search must be initialized at server startup; extraction threads disable it.
      await writeFile(join(dir, 'config.toml'), `approval_policy = "never"
sandbox_mode = "read-only"
web_search = "live"
project_doc_max_bytes = 0
service_tier = "default"
personality = "none"
[agents]
enabled = false
[skills]
include_instructions = false
[skills.bundled]
enabled = false
[features]
fast_mode = false
code_mode_host = true
${disabled.map(key => `${key} = false`).join('\n')}
`, { mode: 0o600 });
      if (this.stopped) throw unavailable();
      const child = spawn(process.env.CODEX_BIN || '/usr/local/bin/codex', ['app-server', '--listen', 'stdio://'], {
        cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: dir },
        stdio: ['pipe', 'pipe', 'pipe'], detached: true
      });
      const pending = new Map(), threads = new Map();
      connection = { child, dir, pending, threads, initialized: false, closed: false, seq: 0 };
      this.connection = connection;
      connection.exited = new Promise(resolve => child.once('close', resolve));
      const send = message => {
        if (connection.closed || !child.stdin.writable) throw unavailable();
        child.stdin.write(JSON.stringify(message) + '\n');
      };
      connection.rpc = (method, params) => new Promise((resolve, reject) => {
        const id = ++connection.seq;
        const timer = setTimeout(() => {
          pending.delete(id); reject(unavailable());
          log('transport_timeout', { method }); disconnect();
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
      connection.kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const disconnect = () => {
        if (connection.closed) return;
        connection.closed = true;
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable()); }
        pending.clear();
        for (const request of threads.values()) request.fail(unavailable());
        threads.clear();
        if (this.connection === connection) this.connection = null;
        connection.kill();
        this.scheduleRestart();
      };
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.id != null && !event.method) {
          const request = pending.get(event.id);
          if (!request) return;
          pending.delete(event.id); clearTimeout(request.timer);
          event.error ? request.reject(Object.assign(new Error('Codex no pudo iniciar la solicitud.'), { code: 'CODEX_RPC_FAILED' })) : request.resolve(event.result);
        } else if (event.id != null) {
          try { send({ id: event.id, error: { code: -32601, message: 'Operación no permitida.' } }); } catch {}
        } else {
          const request = threads.get(event.params?.threadId);
          if (request) try { request.event(event.method, event.params); } catch (error) { request.fail(error); }
        }
      });
      // Diagnostics can contain credentials or user data; never forward them.
      child.stderr.on('data', () => {});
      child.stdin.on('error', disconnect);
      child.once('error', disconnect);
      child.once('close', (exitCode, signal) => {
        lines.close(); disconnect(); log('process_exit', { pid: child.pid, exitCode, signal });
        rm(dir, { recursive: true, force: true }).catch(() => {});
      });
      log('spawned', { pid: child.pid });
      await connection.rpc('initialize', { clientInfo: { name: 'foodtrack', title: 'Comida', version: '1.0.0' } });
      send({ method: 'initialized' });
      connection.initialized = true;
      this.restartDelay = 1000;
      log('ready', { pid: child.pid });
      return connection;
    } catch (error) {
      if (connection) connection.kill();
      else if (dir) await rm(dir, { recursive: true, force: true });
      log('start_failed');
      this.scheduleRestart();
      throw error;
    }
  }
  async run({ model, fast = false, instructions, developerInstructions, prompt, imagePath,
    outputSchema, webSearch = false, signal, onText = () => {}, onUsage = () => {},
    onSearch = () => {}, log = () => {}, timeoutMs = 180000 }) {
    let connection, threadId, turnId, settled = false, completed = false, interrupted = false, finalText = '';
    const parts = new Map();
    let resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    done.catch(() => {});
    const fail = error => { if (!settled) { settled = true; rejectDone(error); } };
    const interrupt = () => {
      if (!completed && !interrupted && threadId && turnId && !connection.closed) {
        interrupted = true;
        connection.rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
    };
    const abort = () => { fail(new Error('Consulta cancelada.')); interrupt(); };
    const timer = setTimeout(() => { fail(Object.assign(new Error('La consulta tardó demasiado. Volvé a intentarlo.'), { code: 'CODEX_TIMEOUT' })); interrupt(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const publish = () => {
      finalText = outputSchema ? [...parts.values()].at(-1) || '' : [...parts.values()].join('\n\n');
      if (finalText.length > (outputSchema ? 128000 : 16000)) throw new Error('La respuesta es demasiado larga.');
      onText(finalText);
    };
    const setup = async () => {
      connection = await this.ready();
      if (settled) return;
      log('server_ready', { pid: connection.child.pid });
      const { thread } = await connection.rpc('thread/start', {
        cwd: connection.dir, model, serviceTier: fast ? 'fast' : 'default',
        ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: instructions, ...(developerInstructions ? { developerInstructions } : {}),
        config: { web_search: webSearch ? 'live' : 'disabled', features: { fast_mode: fast, code_mode_host: webSearch } }
      });
      threadId = thread.id;
      if (settled) { connection.rpc('thread/unsubscribe', { threadId }).catch(() => {}); return; }
      log('thread_started', { threadId });
      connection.threads.set(threadId, { fail, event: AsyncLocalStorage.bind((method, params) => {
        if (settled) return;
        if (method === 'thread/tokenUsage/updated') onUsage(params.tokenUsage?.total);
        else if (method === 'item/agentMessage/delta') { parts.set(params.itemId, (parts.get(params.itemId) || '') + params.delta); publish(); }
        else if (method === 'item/completed' && params.item?.type === 'agentMessage') { parts.set(params.item.id, params.item.text); publish(); }
        else if (method === 'item/started' && params.item?.type === 'webSearch') onSearch('started');
        else if (method === 'item/completed' && params.item?.type === 'webSearch') onSearch('completed');
        else if (method === 'turn/completed') {
          if (params.turn?.status !== 'completed') fail(unavailable());
          else { completed = true; settled = true; resolveDone(); }
        } else if (method === 'error' && !params.willRetry) fail(unavailable());
      }) });
      const input = [{ type: 'text', text: prompt, text_elements: [] }];
      if (imagePath) input.push({ type: 'localImage', path: imagePath });
      const { turn } = await connection.rpc('turn/start', {
        threadId, model, effort: 'low', serviceTier: fast ? 'fast' : 'default', input,
        ...(outputSchema ? { outputSchema } : {})
      });
      turnId = turn.id;
      log('turn_started', { threadId, turnId });
      if (settled) interrupt();
    };
    try {
      // Timeout/cancellation covers startup and handshake as well as the turn.
      await Promise.race([setup(), done]);
      await done;
      if (!finalText.trim()) throw new Error('Codex no devolvió una respuesta.');
      return finalText;
    } finally {
      interrupt();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (threadId) {
        connection.threads.delete(threadId);
        if (!connection.closed) await connection.rpc('thread/unsubscribe', { threadId }).catch(() => {});
      }
    }
  }
  async stop() {
    this.stopped = true;
    this.keepAlive = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    // Startup must settle before removing its private configuration.
    const connection = this.connection;
    connection?.kill();
    await this.starting?.catch(() => {});
    const current = this.connection || connection;
    current?.kill();
    if (current) { await current.exited; await rm(current.dir, { recursive: true, force: true }); }
    this.connection = null;
  }
}
export const codexServer = new CodexServer();

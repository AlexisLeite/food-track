import { spawn } from 'node:child_process';
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore','ignore','pipe'], ...options });
    // PostgreSQL may include connection details in stderr; don't forward secrets.
    child.stderr?.resume();
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${file} failed with exit code ${code}`)));
  });
}
export async function backupPostgres(url, filename) {
  const parsed = new URL(url);
  if (parsed.searchParams.has('schema')) throw new Error('Back up the complete database, not an isolated test schema');
  await mkdir(dirname(filename), { recursive:true, mode:0o700 });
  const file = await open(filename, 'wx', 0o600);
  await file.close();
  try {
    await command('pg_dump', ['--format=custom','--no-owner','--no-acl','--host',parsed.hostname,'--port',parsed.port||'5432','--username',decodeURIComponent(parsed.username),'--dbname',decodeURIComponent(parsed.pathname.slice(1)),'--file',filename], { env:{...process.env,PGPASSWORD:decodeURIComponent(parsed.password)} });
    await command('pg_restore', ['--list', filename]);
    return filename;
  } catch(error) { await unlink(filename).catch(()=>{}); throw error; }
}

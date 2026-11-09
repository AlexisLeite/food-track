import { backupPostgres } from '../server/database-backup.js';
import { resolve } from 'node:path';
process.umask(0o077);
const stamp=new Date().toISOString().replaceAll(':','').replaceAll('.','');
try {
  const file=resolve(process.argv[2] || `${process.env.DATA_DIR||'data'}/backups/postgresql-${stamp}.dump`);
  await backupPostgres(process.env.DATABASE_URL,file);
  console.log(`Respaldo PostgreSQL verificado: ${file}`);
} catch(error) {console.error(error.code||error.message);process.exitCode=1;}

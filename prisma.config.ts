import { defineConfig } from 'prisma/config';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL || 'postgresql://localhost/foodtrack' },
});

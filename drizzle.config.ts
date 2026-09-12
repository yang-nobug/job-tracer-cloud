import { defineConfig } from 'drizzle-kit'

// `db:generate` 只读取 schema，不连接数据库。实际迁移由 server/src/database/migrate.ts
// 在验证 DATABASE_URL 后执行，避免误连到占位地址。
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://job_tracer:change-me@127.0.0.1:5432/job_tracer'

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/src/database/schema.ts',
  out: './server/src/database/migrations',
  dbCredentials: { url: databaseUrl },
  verbose: true,
  strict: true
})

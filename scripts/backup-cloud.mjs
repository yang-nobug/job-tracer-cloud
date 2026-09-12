#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法：npm run backup:cloud [-- --output /安全的备份目录]')
  console.log('需要：已加载 DATABASE_URL；服务器需安装 pg_dump。')
  process.exit(0)
}
const outputIndex = args.indexOf('--output')
if (outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith('--'))) {
  throw new Error('--output 后必须提供备份根目录')
}
const backupRoot = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : path.join(root, 'backups'))
const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL 未配置；请先加载 /etc/job-tracer/job-tracer.env')

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const finalDir = path.join(backupRoot, `job-tracer_${stamp}`)
const partialDir = `${finalDir}.partial`
if (existsSync(partialDir) || existsSync(finalDir)) throw new Error('备份目录已存在，请稍后重试')

const dataDir = process.env.JOB_TRACER_DATA_DIR?.trim()
  ? path.resolve(process.env.JOB_TRACER_DATA_DIR.trim())
  : path.join(root, 'data')
const keyDir = process.env.JOB_TRACER_KEY_DIR?.trim()
  ? path.resolve(process.env.JOB_TRACER_KEY_DIR.trim())
  : path.join(os.homedir(), '.job-tracer')
const configPath = process.env.JOB_TRACER_CONFIG_PATH?.trim()
  ? path.resolve(process.env.JOB_TRACER_CONFIG_PATH.trim())
  : path.join(root, 'config.json')

function restrict(target) {
  try { chmodSync(target, 0o700) } catch { /* Windows 不支持 POSIX 权限；云端 Ubuntu 会生效。 */ }
}

function copyIfPresent(source, target) {
  if (!existsSync(source)) return false
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  cpSync(source, target, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true })
  try { chmodSync(target, statSync(source).isDirectory() ? 0o700 : 0o600) } catch { /* 仅云端 POSIX 权限需强制。 */ }
  return true
}

function run(command, commandArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, stdio: 'inherit' })
    child.once('error', error => reject(new Error(`${command} 无法启动：${error.message}`)))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} 执行失败，退出码 ${code ?? 'unknown'}`)))
  })
}

function listFiles(directory, base = directory) {
  if (!existsSync(directory)) return []
  const rows = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) rows.push(...listFiles(target, base))
    else if (entry.isFile()) {
      rows.push({
        path: path.relative(base, target).split(path.sep).join('/'),
        bytes: statSync(target).size,
        sha256: createHash('sha256').update(readFileSync(target)).digest('hex')
      })
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path))
}

async function main() {
  const parsed = new URL(databaseUrl)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL 必须使用 PostgreSQL 连接串')
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(parsed.username)
  if (!database || !user) throw new Error('DATABASE_URL 缺少数据库名或用户名')

  mkdirSync(partialDir, { recursive: true, mode: 0o700 })
  restrict(partialDir)
  const dumpPath = path.join(partialDir, 'database.dump')
  console.log(`[backup] 导出 PostgreSQL：${database}`)
  await run('pg_dump', [
    '--no-password', '--host', parsed.hostname, '--port', parsed.port || '5432', '--username', user,
    '--format=custom', '--no-owner', '--file', dumpPath, database
  ], { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) })

  const copied = {
    workspaceFiles: copyIfPresent(path.join(dataDir, 'workspace_files'), path.join(partialDir, 'data', 'workspace_files')),
    mailSecrets: copyIfPresent(path.join(dataDir, 'secrets'), path.join(partialDir, 'data', 'secrets')),
    mailMasterKey: copyIfPresent(path.join(keyDir, 'mail-master.key'), path.join(partialDir, 'keys', 'mail-master.key')),
    serverConfig: copyIfPresent(configPath, path.join(partialDir, 'config', 'config.json'))
  }
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    database: { format: 'pg_dump custom', name: database },
    copied,
    warning: '此备份包含邮箱授权码的加密文件、其主密钥和可能存在的模型配置。请仅保存到加密且受访问控制的位置。数据库连接串不在本备份内。',
    files: listFiles(partialDir)
  }
  writeFileSync(path.join(partialDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  restrict(path.join(partialDir, 'data'))
  restrict(path.join(partialDir, 'keys'))
  restrict(path.join(partialDir, 'config'))
  renameSync(partialDir, finalDir)
  console.log(`[backup] 完成：${finalDir}`)
  console.log('[backup] 该目录含敏感材料；请复制至加密存储，并定期验证可恢复性。')
}

main().catch(error => {
  console.error('[backup] 失败：', error instanceof Error ? error.message : error)
  console.error(`[backup] 未完成目录保留在：${partialDir}`)
  process.exitCode = 1
})

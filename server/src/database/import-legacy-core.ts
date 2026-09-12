import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { closePostgres, getPostgresSql } from './client.js'
import { requirePostgresConfig } from './config.js'

type LegacyApplication = Record<string, unknown> & { id: number }
type LegacyEvent = Record<string, unknown> & { application_id: number }
type LegacyInterview = Record<string, unknown> & { id: number; application_id: number }
type LegacyChecklist = Record<string, unknown> & { interview_id: number }

function value(row: Record<string, unknown>, key: string): string | null {
  const input = row[key]
  return input == null ? null : String(input)
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} 未配置`)
  return value
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(item => item.name === column)
}

async function main(): Promise<void> {
  requirePostgresConfig()
  const sourcePath = path.resolve(required('LEGACY_SQLITE_PATH'))
  const email = required('LEGACY_IMPORT_EMAIL').toLowerCase()
  if (!existsSync(sourcePath)) throw new Error(`找不到 SQLite 文件：${sourcePath}`)
  if (!statSync(sourcePath).isFile()) throw new Error('LEGACY_SQLITE_PATH 必须指向 job-tracer.db 文件')

  const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
  const legacy = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    const appColumns = ['id', 'company', 'position', 'status', 'applied_at', 'channel', 'location', 'jd_link', 'jd_text', 'contact_name', 'contact_info', 'notes', 'rejected_at', 'reject_type', 'created_at', 'updated_at']
    if (hasColumn(legacy, 'applications', 'applied_time')) appColumns.push('applied_time')
    if (hasColumn(legacy, 'applications', 'application_link')) appColumns.push('application_link')
    const applications = legacy.prepare(`SELECT ${appColumns.join(',')} FROM applications ORDER BY id`).all() as LegacyApplication[]
    const events = legacy.prepare('SELECT id,application_id,type,event_date,content,created_at FROM events ORDER BY id').all() as LegacyEvent[]
    const interviews = legacy.prepare('SELECT id,application_id,round,scheduled_at,location,review_file,done,created_at FROM interviews ORDER BY id').all() as LegacyInterview[]
    const checklists = legacy.prepare('SELECT id,interview_id,content,done,sort FROM checklist_items ORDER BY id').all() as LegacyChecklist[]
    const sql = getPostgresSql()
    const destinations = await sql.unsafe(
      `SELECT u.id AS user_id, wm.workspace_id FROM users u
       JOIN workspace_members wm ON wm.user_id=u.id
       WHERE u.email_normalized=$1 AND u.status='active'
       ORDER BY (wm.role='owner') DESC, wm.created_at ASC LIMIT 1`, [email]
    ) as Array<{ user_id: string; workspace_id: string }>
    const destination = destinations[0]
    if (!destination) throw new Error('找不到可用的目标用户或工作区，请检查 LEGACY_IMPORT_EMAIL')

    await sql.begin(async transaction => {
      const existing = await transaction.unsafe('SELECT id FROM legacy_core_imports WHERE workspace_id=$1 OR source_hash=$2', [destination.workspace_id, sourceHash])
      if (existing.length) throw new Error('该工作区或该 SQLite 文件已经导入过，已停止以避免重复数据')
      const existingApps = await transaction.unsafe('SELECT COUNT(*)::integer AS count FROM applications WHERE workspace_id=$1', [destination.workspace_id]) as Array<{ count: number }>
      if (existingApps[0]?.count) throw new Error('目标工作区已有投递记录；请先使用空工作区，避免合并时出现重复数据')

      const appIds = new Map<number, number>()
      for (const app of applications) {
        const inserted = await transaction.unsafe(
          `INSERT INTO applications (workspace_id,company,position,status,applied_at,applied_time,channel,location,jd_link,application_link,jd_text,contact_name,contact_info,notes,rejected_at,reject_type,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [destination.workspace_id, value(app, 'company') || '', value(app, 'position') || '', value(app, 'status') || 'unsent', value(app, 'applied_at'), value(app, 'applied_time'), value(app, 'channel'), value(app, 'location'), value(app, 'jd_link'), value(app, 'application_link'), value(app, 'jd_text'), value(app, 'contact_name'), value(app, 'contact_info'), value(app, 'notes'), value(app, 'rejected_at'), value(app, 'reject_type'), value(app, 'created_at') || new Date().toISOString(), value(app, 'updated_at') || new Date().toISOString()]
        ) as Array<{ id: number }>
        appIds.set(Number(app.id), inserted[0].id)
      }

      let importedEvents = 0
      for (const event of events) {
        const applicationId = appIds.get(Number(event.application_id))
        if (!applicationId) continue
        await transaction.unsafe(
          'INSERT INTO application_events (workspace_id,application_id,type,event_date,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [destination.workspace_id, applicationId, value(event, 'type') || 'note', value(event, 'event_date') || '1970-01-01', value(event, 'content') || '', value(event, 'created_at') || new Date().toISOString()]
        )
        importedEvents++
      }

      const interviewIds = new Map<number, number>()
      for (const interview of interviews) {
        const applicationId = appIds.get(Number(interview.application_id))
        if (!applicationId) continue
        const inserted = await transaction.unsafe(
          `INSERT INTO interviews (workspace_id,application_id,round,scheduled_at,location,review_file,done,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [destination.workspace_id, applicationId, value(interview, 'round') || '其他', value(interview, 'scheduled_at') || '1970-01-01 00:00', value(interview, 'location'), value(interview, 'review_file'), Boolean(interview.done), value(interview, 'created_at') || new Date().toISOString()]
        ) as Array<{ id: number }>
        interviewIds.set(Number(interview.id), inserted[0].id)
      }

      let importedChecklists = 0
      for (const item of checklists) {
        const interviewId = interviewIds.get(Number(item.interview_id))
        if (!interviewId) continue
        await transaction.unsafe(
          'INSERT INTO checklist_items (workspace_id,interview_id,content,done,sort) VALUES ($1,$2,$3,$4,$5)',
          [destination.workspace_id, interviewId, value(item, 'content') || '', Boolean(item.done), Number(item.sort) || 0]
        )
        importedChecklists++
      }

      await transaction.unsafe(
        `INSERT INTO legacy_core_imports (workspace_id,source_hash,source_label,applications_count,events_count,interviews_count,checklist_items_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [destination.workspace_id, sourceHash, path.basename(sourcePath), applications.length, importedEvents, interviewIds.size, importedChecklists]
      )
    })
    console.log(`[database] 已导入核心业务数据：${applications.length} 条投递、${events.length} 条动态、${interviews.length} 场面试、${checklists.length} 个清单项`)
    console.log('[database] 提醒：简历文件、录音、知识库与邮件日程不在本次核心导入范围内，将在对应模块迁移时单独处理。')
  } finally {
    legacy.close()
    await closePostgres()
  }
}

main().catch(error => {
  console.error('[database] 导入失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

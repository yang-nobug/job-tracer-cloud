import {
  boolean,
  integer,
  index,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core'

/**
 * 云端身份与工作区基础表。
 * 业务表将在逐模块迁移时统一增加 workspaceId，禁止建立无工作区归属的数据。
 */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 320 }).notNull(),
  // 统一小写和去空格后的邮箱，用于数据库层面的唯一性约束。
  emailNormalized: varchar('email_normalized', { length: 320 }).notNull(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  status: varchar('status', { length: 24 }).notNull().default('active'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('users_email_normalized_unique').on(table.emailNormalized)
])

export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 24 }).notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.workspaceId, table.userId], name: 'workspace_members_pkey' }),
  index('workspace_members_user_id_idx').on(table.userId)
])

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 128 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
  index('sessions_user_id_idx').on(table.userId),
  index('sessions_expires_at_idx').on(table.expiresAt)
])

/** 提交后必须由平台管理员审批；批准时才创建 users 与个人 workspace。 */
export const registrationRequests = pgTable('registration_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 320 }).notNull(),
  emailNormalized: varchar('email_normalized', { length: 320 }).notNull(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  // 审批通过或拒绝后清空，避免在申请记录中长期保留密码哈希。
  passwordHash: text('password_hash'),
  status: varchar('status', { length: 24 }).notNull().default('pending'),
  reviewNote: text('review_note'),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  approvedUserId: uuid('approved_user_id').references(() => users.id, { onDelete: 'set null' }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('registration_requests_email_normalized_unique').on(table.emailNormalized),
  index('registration_requests_status_requested_at_idx').on(table.status, table.requestedAt)
])

/**
 * 第一批已经迁入云端的业务数据。ID 继续使用整数，保持既有 Web API 的
 * 调用方式不变；workspaceId 是每张表的不可空隔离边界。
 */
export const applications = pgTable('applications', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  company: text('company').notNull(),
  position: text('position').notNull(),
  status: varchar('status', { length: 24 }).notNull().default('unsent'),
  appliedAt: varchar('applied_at', { length: 10 }),
  appliedTime: varchar('applied_time', { length: 8 }),
  channel: text('channel'),
  location: text('location'),
  resumeId: integer('resume_id'),
  jdLink: text('jd_link'),
  applicationLink: text('application_link'),
  jdText: text('jd_text'),
  contactName: text('contact_name'),
  contactInfo: text('contact_info'),
  notes: text('notes'),
  rejectedAt: varchar('rejected_at', { length: 10 }),
  rejectType: varchar('reject_type', { length: 16 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('applications_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
  index('applications_workspace_status_idx').on(table.workspaceId, table.status),
  index('applications_workspace_company_idx').on(table.workspaceId, table.company)
])

/** 原始简历文件仍在服务器私有磁盘；数据库只保存文件名和所属工作区。 */
export const resumes = pgTable('resumes', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  storedName: varchar('stored_name', { length: 160 }).notNull(),
  size: integer('size').notNull(),
  note: varchar('note', { length: 80 }),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('resumes_workspace_stored_name_unique').on(table.workspaceId, table.storedName),
  index('resumes_workspace_uploaded_idx').on(table.workspaceId, table.uploadedAt)
])

export const resumeTexts = pgTable('resume_texts', {
  resumeId: integer('resume_id').primaryKey().references(() => resumes.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 24 }).notNull().default('pending'),
  textContent: text('text_content'),
  contentHash: varchar('content_hash', { length: 64 }),
  errorMessage: text('error_message'),
  extractionMethod: varchar('extraction_method', { length: 24 }),
  model: varchar('model', { length: 200 }),
  pageCount: integer('page_count'),
  pagesCompleted: integer('pages_completed').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  extractedAt: timestamp('extracted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('resume_texts_workspace_status_idx').on(table.workspaceId, table.status)
])

/**
 * 知识库的面经源、题目、截图和答案版本均按工作区隔离。
 * owner 仍保留“我的面试 / 他人面经”的学习语义，但不再表示跨账号可见性。
 */
export const knowledgeSources = pgTable('knowledge_sources', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  owner: varchar('owner', { length: 16 }).notNull().default('others'),
  company: text('company').notNull(),
  position: text('position'),
  round: varchar('round', { length: 40 }),
  sourceType: varchar('source_type', { length: 16 }).notNull().default('manual'),
  note: text('note'),
  applicationId: integer('application_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('knowledge_sources_workspace_created_idx').on(table.workspaceId, table.createdAt),
  index('knowledge_sources_workspace_company_idx').on(table.workspaceId, table.company)
])

export const knowledgeItems = pgTable('knowledge_items', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: integer('source_id').references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  answer: text('answer'),
  category: varchar('category', { length: 32 }).notNull().default('其他'),
  subCategory: varchar('sub_category', { length: 100 }),
  mastery: integer('mastery').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('knowledge_items_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
  index('knowledge_items_workspace_source_idx').on(table.workspaceId, table.sourceId),
  index('knowledge_items_workspace_category_idx').on(table.workspaceId, table.category),
  index('knowledge_items_workspace_mastery_idx').on(table.workspaceId, table.mastery)
])

export const knowledgeImages = pgTable('knowledge_images', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: integer('source_id').notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  storedName: varchar('stored_name', { length: 160 }).notNull(),
  inferenceStoredName: varchar('inference_stored_name', { length: 160 }),
  inferenceMime: varchar('inference_mime', { length: 80 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('knowledge_images_workspace_stored_name_unique').on(table.workspaceId, table.storedName),
  index('knowledge_images_workspace_source_idx').on(table.workspaceId, table.sourceId)
])

export const knowledgeAnswerVersions = pgTable('knowledge_answer_versions', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  knowledgeItemId: integer('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  answer: text('answer').notNull(),
  reason: varchar('reason', { length: 40 }).notNull(),
  model: varchar('model', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('knowledge_answer_versions_workspace_item_idx').on(table.workspaceId, table.knowledgeItemId, table.id)
])

export const applicationEvents = pgTable('application_events', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  applicationId: integer('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 24 }).notNull(),
  eventDate: varchar('event_date', { length: 10 }).notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('application_events_workspace_application_idx').on(table.workspaceId, table.applicationId, table.eventDate)
])

export const interviews = pgTable('interviews', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  applicationId: integer('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  round: varchar('round', { length: 40 }).notNull(),
  scheduledAt: varchar('scheduled_at', { length: 16 }).notNull(),
  location: text('location'),
  reviewFile: text('review_file'),
  done: boolean('done').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('interviews_workspace_time_idx').on(table.workspaceId, table.scheduledAt),
  index('interviews_workspace_application_idx').on(table.workspaceId, table.applicationId)
])

export const checklistItems = pgTable('checklist_items', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  interviewId: integer('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  done: boolean('done').notNull().default(false),
  sort: integer('sort').notNull().default(0)
}, table => [
  index('checklist_items_workspace_interview_idx').on(table.workspaceId, table.interviewId, table.sort)
])

/** 旧 SQLite 核心业务数据的一次性导入凭据，防止误重复导入。 */
export const legacyCoreImports = pgTable('legacy_core_imports', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  sourceLabel: text('source_label').notNull(),
  applicationsCount: integer('applications_count').notNull().default(0),
  eventsCount: integer('events_count').notNull().default(0),
  interviewsCount: integer('interviews_count').notNull().default(0),
  checklistItemsCount: integer('checklist_items_count').notNull().default(0),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('legacy_core_imports_workspace_unique').on(table.workspaceId),
  uniqueIndex('legacy_core_imports_source_hash_unique').on(table.sourceHash)
])

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
  /** 同意后才可进入互惠共享岗位页，同时本人的岗位公开字段参与共享。 */
  sharedJobsConsentAt: timestamp('shared_jobs_consent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('users_email_normalized_unique').on(table.emailNormalized)
])

/** 平台共用的非机密 AI 偏好；密钥与模型清单仍只由服务器 config.json 管理。 */
export const platformAiSettings = pgTable('platform_ai_settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: text('value').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

/** 平台运维日志，不含工作区业务正文；仅平台管理员可查看和清理。 */
export const platformSystemLogs = pgTable('platform_system_logs', {
  id: serial('id').primaryKey(),
  level: varchar('level', { length: 12 }).notNull(),
  source: varchar('source', { length: 80 }).notNull(),
  eventName: varchar('event_name', { length: 120 }).notNull(),
  traceId: varchar('trace_id', { length: 100 }),
  operationRunId: integer('operation_run_id'),
  operationStepId: integer('operation_step_id'),
  entityType: varchar('entity_type', { length: 100 }),
  entityId: varchar('entity_id', { length: 200 }),
  message: text('message').notNull(),
  contextJson: text('context_json'),
  errorCode: varchar('error_code', { length: 120 }),
  errorStack: text('error_stack'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('platform_system_logs_created_idx').on(table.id),
  index('platform_system_logs_trace_idx').on(table.traceId, table.id),
  index('platform_system_logs_error_idx').on(table.level, table.errorCode, table.id)
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

/** AI 助教会话及其引用、反馈。会话内容与检索结果均只属于一个工作区。 */
export const workspaceTutorSessions = pgTable('workspace_tutor_sessions', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 80 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('workspace_tutor_sessions_workspace_updated_idx').on(table.workspaceId, table.updatedAt)
])

export const workspaceTutorMessages = pgTable('workspace_tutor_messages', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').notNull().references(() => workspaceTutorSessions.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).notNull(),
  content: text('content').notNull(),
  requestId: varchar('request_id', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('workspace_tutor_messages_request_unique').on(table.sessionId, table.role, table.requestId),
  index('workspace_tutor_messages_session_created_idx').on(table.sessionId, table.createdAt, table.id)
])

export const workspaceTutorMessageCitations = pgTable('workspace_tutor_message_citations', {
  messageId: integer('message_id').notNull().references(() => workspaceTutorMessages.id, { onDelete: 'cascade' }),
  knowledgeItemId: integer('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  citationKey: varchar('citation_key', { length: 16 }).notNull(),
  rank: integer('rank').notNull(),
  score: integer('score').notNull().default(0)
}, table => [
  primaryKey({ columns: [table.messageId, table.knowledgeItemId], name: 'workspace_tutor_message_citations_pkey' }),
  index('workspace_tutor_message_citations_item_idx').on(table.knowledgeItemId)
])

export const workspaceTutorMessageFeedback = pgTable('workspace_tutor_message_feedback', {
  messageId: integer('message_id').primaryKey().references(() => workspaceTutorMessages.id, { onDelete: 'cascade' }),
  value: integer('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

/**
 * 八股学习资料库。公共八股册的 workspaceId 为 null，仅管理员可修改；
 * 私有八股册归属一个工作区。题目熟悉度和笔记按 userId 保存，不会形成复习任务。
 */
export const studyBooks = pgTable('study_books', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  visibility: varchar('visibility', { length: 16 }).notNull().default('private'),
  directoryKey: varchar('directory_key', { length: 48 }).notNull(),
  title: varchar('title', { length: 160 }).notNull(),
  description: text('description').notNull().default(''),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('study_books_directory_idx').on(table.directoryKey, table.visibility, table.id),
  index('study_books_workspace_idx').on(table.workspaceId, table.updatedAt)
])

export const studyChapters = pgTable('study_chapters', {
  id: serial('id').primaryKey(),
  bookId: integer('book_id').notNull().references(() => studyBooks.id, { onDelete: 'cascade' }),
  /** 目录可嵌套；NULL 表示八股册的顶层目录。 */
  parentId: integer('parent_id').references(() => studyChapters.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 160 }).notNull(),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('study_chapters_book_sort_idx').on(table.bookId, table.sort, table.id),
  index('study_chapters_parent_sort_idx').on(table.parentId, table.sort, table.id)
])

export const studyCards = pgTable('study_cards', {
  id: serial('id').primaryKey(),
  chapterId: integer('chapter_id').notNull().references(() => studyChapters.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  summary: text('summary').notNull().default(''),
  answer: text('answer').notNull().default(''),
  followupsJson: text('followups_json').notNull().default('[]'),
  tagsJson: text('tags_json').notNull().default('[]'),
  difficulty: varchar('difficulty', { length: 16 }).notNull().default('基础'),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [index('study_cards_chapter_sort_idx').on(table.chapterId, table.sort, table.id)])

export const studyCardProgress = pgTable('study_card_progress', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  cardId: integer('card_id').notNull().references(() => studyCards.id, { onDelete: 'cascade' }),
  familiarity: integer('familiarity').notNull().default(0),
  note: text('note').notNull().default(''),
  lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.userId, table.cardId], name: 'study_card_progress_pkey' }),
  index('study_card_progress_user_familiarity_idx').on(table.userId, table.familiarity, table.updatedAt)
])

/** 云端项目档案只引用用户主动上传的 ZIP；源码索引不包含服务器任意目录路径。 */
export const workspaceProjectProfiles = pgTable('workspace_project_profiles', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(), description: text('description').notNull().default(''),
  archiveFilename: text('archive_filename').notNull(), archiveStoredName: varchar('archive_stored_name', { length: 160 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('ready'), scanScopesJson: text('scan_scopes_json').notNull().default('["."]'),
  filesSeen: integer('files_seen').notNull().default(0), filesIndexed: integer('files_indexed').notNull().default(0), bytesRead: integer('bytes_read').notNull().default(0), truncated: boolean('truncated').notNull().default(false), skippedJson: text('skipped_json').notNull().default('{}'), scannedAt: timestamp('scanned_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_project_profiles_archive_unique').on(table.workspaceId, table.archiveStoredName), index('workspace_project_profiles_workspace_updated_idx').on(table.workspaceId, table.updatedAt)])

export const workspaceProjectFiles = pgTable('workspace_project_files', {
  id: serial('id').primaryKey(), projectId: integer('project_id').notNull().references(() => workspaceProjectProfiles.id, { onDelete: 'cascade' }), relativePath: text('relative_path').notNull(), language: varchar('language', { length: 32 }).notNull(), sizeBytes: integer('size_bytes').notNull(), lineCount: integer('line_count').notNull(), contentHash: varchar('content_hash', { length: 64 }).notNull(), indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_project_files_path_unique').on(table.projectId, table.relativePath), index('workspace_project_files_project_path_idx').on(table.projectId, table.relativePath)])

export const workspaceProjectChunks = pgTable('workspace_project_chunks', {
  id: serial('id').primaryKey(), projectId: integer('project_id').notNull().references(() => workspaceProjectProfiles.id, { onDelete: 'cascade' }), fileId: integer('file_id').notNull().references(() => workspaceProjectFiles.id, { onDelete: 'cascade' }), startLine: integer('start_line').notNull(), endLine: integer('end_line').notNull(), content: text('content').notNull(), contentHash: varchar('content_hash', { length: 64 }).notNull()
}, table => [index('workspace_project_chunks_project_file_idx').on(table.projectId, table.fileId)])

export const workspaceProjectFacts = pgTable('workspace_project_facts', {
  id: serial('id').primaryKey(), projectId: integer('project_id').notNull().references(() => workspaceProjectProfiles.id, { onDelete: 'cascade' }), factType: varchar('fact_type', { length: 40 }).notNull(), title: varchar('title', { length: 300 }).notNull(), content: text('content').notNull(), evidenceChunkIdsJson: text('evidence_chunk_ids_json').notNull().default('[]'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [index('workspace_project_facts_project_idx').on(table.projectId, table.id)])

/** 代码理解 Agent 只读取 workspace_project_chunks 中已过滤的索引。 */
export const workspaceCodeReadingSessions = pgTable('workspace_code_reading_sessions', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), projectId: integer('project_id').notNull().references(() => workspaceProjectProfiles.id, { onDelete: 'cascade' }), question: text('question').notNull(), outputMode: varchar('output_mode', { length: 24 }).notNull(), status: varchar('status', { length: 20 }).notNull().default('queued'), model: varchar('model', { length: 200 }), toolCallsUsed: integer('tool_calls_used').notNull().default(0), bytesRead: integer('bytes_read').notNull().default(0), maxToolCalls: integer('max_tool_calls').notNull().default(8), maxBytesRead: integer('max_bytes_read').notNull().default(163840), finalJson: text('final_json'), errorMessage: text('error_message'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp('finished_at', { withTimezone: true })
}, table => [index('workspace_code_reading_sessions_project_created_idx').on(table.workspaceId, table.projectId, table.createdAt)])
export const workspaceCodeReadingSteps = pgTable('workspace_code_reading_steps', { id: serial('id').primaryKey(), sessionId: uuid('session_id').notNull().references(() => workspaceCodeReadingSessions.id, { onDelete: 'cascade' }), sequence: integer('sequence').notNull(), kind: varchar('kind', { length: 16 }).notNull(), toolName: varchar('tool_name', { length: 40 }), status: varchar('status', { length: 16 }).notNull(), errorMessage: text('error_message'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow() }, table => [index('workspace_code_reading_steps_session_idx').on(table.sessionId, table.sequence)])
export const workspaceCodeReadingEvidence = pgTable('workspace_code_reading_evidence', { id: serial('id').primaryKey(), sessionId: uuid('session_id').notNull().references(() => workspaceCodeReadingSessions.id, { onDelete: 'cascade' }), evidenceRef: varchar('evidence_ref', { length: 20 }).notNull(), relativePath: text('relative_path').notNull(), startLine: integer('start_line').notNull(), endLine: integer('end_line').notNull(), excerpt: text('excerpt').notNull() }, table => [uniqueIndex('workspace_code_reading_evidence_ref_unique').on(table.sessionId, table.evidenceRef), index('workspace_code_reading_evidence_session_idx').on(table.sessionId, table.id)])

/** 每一次云端模型调用的脱敏审计。内容只属于本工作区，图片仅保留哈希而非原始 Base64。 */
export const workspaceAiCallRecords = pgTable('workspace_ai_call_records', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  task: varchar('task', { length: 80 }).notNull(), stage: varchar('stage', { length: 120 }).notNull(), attempt: integer('attempt').notNull().default(1), retryOfCallId: integer('retry_of_call_id'), model: varchar('model', { length: 200 }), promptHash: varchar('prompt_hash', { length: 64 }).notNull(), providerRequestId: varchar('provider_request_id', { length: 200 }),
  requestMessagesJson: text('request_messages_json').notNull(), responseSchemaJson: text('response_schema_json'), requestOptionsJson: text('request_options_json'), rawResponse: text('raw_response'), parsedResponseJson: text('parsed_response_json'), validatedResponseJson: text('validated_response_json'), status: varchar('status', { length: 32 }).notNull(), errorType: varchar('error_type', { length: 80 }), errorMessage: text('error_message'), durationMs: integer('duration_ms').notNull(), finishReason: varchar('finish_reason', { length: 80 }), promptTokens: integer('prompt_tokens'), completionTokens: integer('completion_tokens'), totalTokens: integer('total_tokens'), providerAttempts: integer('provider_attempts'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow()
}, table => [index('workspace_ai_call_records_workspace_created_idx').on(table.workspaceId, table.createdAt), index('workspace_ai_call_records_workspace_task_idx').on(table.workspaceId, table.task, table.createdAt)])

/** 招聘智能录入的可核对草稿。未保存的草稿会过期；原材料始终属于单一工作区。 */
export const applicationImports = pgTable('application_imports', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  applicationId: integer('application_id'),
  analysisJson: text('analysis_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
}, table => [
  index('application_imports_workspace_created_idx').on(table.workspaceId, table.createdAt),
  index('application_imports_workspace_application_idx').on(table.workspaceId, table.applicationId)
])

export const applicationMaterials = pgTable('application_materials', {
  // text_1 / image_1 只在同一份导入草稿内唯一，主键必须带上 importId。
  id: varchar('id', { length: 40 }).notNull(),
  importId: uuid('import_id').notNull().references(() => applicationImports.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  textContent: text('text_content'),
  filename: text('filename'),
  storedName: varchar('stored_name', { length: 160 }),
  mime: varchar('mime', { length: 80 }),
  capturedAt: varchar('captured_at', { length: 10 }),
  inferenceStoredName: varchar('inference_stored_name', { length: 160 }),
  inferenceMime: varchar('inference_mime', { length: 80 })
}, table => [
  primaryKey({ columns: [table.importId, table.id], name: 'application_materials_pkey' }),
  index('application_materials_workspace_import_idx').on(table.workspaceId, table.importId),
  uniqueIndex('application_materials_workspace_stored_name_unique').on(table.workspaceId, table.storedName)
])

/** 云端邮箱数据始终有工作区归属；授权码本身仅存服务器私有加密文件。 */
export const workspaceMailAccounts = pgTable('workspace_mail_accounts', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 16 }).notNull(), email: varchar('email', { length: 320 }).notNull(), host: varchar('host', { length: 160 }).notNull(), port: integer('port').notNull(), secure: boolean('secure').notNull().default(true), mailbox: varchar('mailbox', { length: 160 }).notNull().default('INBOX'), credentialRef: varchar('credential_ref', { length: 180 }).notNull(), status: varchar('status', { length: 24 }).notNull().default('connected'), lastTestedAt: timestamp('last_tested_at', { withTimezone: true }), lastErrorCode: varchar('last_error_code', { length: 80 }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_mail_accounts_workspace_unique').on(table.workspaceId)])

export const workspaceMailCandidates = pgTable('workspace_mail_candidates', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), accountId: integer('account_id').notNull().references(() => workspaceMailAccounts.id, { onDelete: 'cascade' }), mailbox: varchar('mailbox', { length: 160 }).notNull(), uidValidity: varchar('uid_validity', { length: 80 }).notNull(), uid: integer('uid').notNull(), subject: text('subject').notNull(), sender: text('sender').notNull(), sentAt: timestamp('sent_at', { withTimezone: true }), isRead: boolean('is_read').notNull().default(false), score: integer('score').notNull().default(0), matchedTermsJson: text('matched_terms_json').notNull().default('[]'), status: varchar('status', { length: 16 }).notNull().default('candidate'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_mail_candidates_message_unique').on(table.accountId, table.mailbox, table.uidValidity, table.uid), index('workspace_mail_candidates_workspace_created_idx').on(table.workspaceId, table.createdAt)])

export const workspaceMailSyncStates = pgTable('workspace_mail_sync_states', {
  accountId: integer('account_id').notNull().references(() => workspaceMailAccounts.id, { onDelete: 'cascade' }), mailbox: varchar('mailbox', { length: 160 }).notNull(), uidValidity: varchar('uid_validity', { length: 80 }).notNull(), lastUid: integer('last_uid').notNull().default(0), lastScannedAt: timestamp('last_scanned_at', { withTimezone: true })
}, table => [primaryKey({ columns: [table.accountId, table.mailbox], name: 'workspace_mail_sync_states_pkey' })])

export const workspaceMailCandidateAnalyses = pgTable('workspace_mail_candidate_analyses', {
  candidateId: integer('candidate_id').primaryKey().references(() => workspaceMailCandidates.id, { onDelete: 'cascade' }), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), status: varchar('status', { length: 16 }).notNull(), extractionJson: text('extraction_json'), bodyHash: varchar('body_hash', { length: 64 }), bodyTruncated: boolean('body_truncated').notNull().default(false), model: varchar('model', { length: 200 }), promptVersion: varchar('prompt_version', { length: 80 }), errorCode: varchar('error_code', { length: 80 }), scheduleReviewJson: text('schedule_review_json'), reviewModel: varchar('review_model', { length: 200 }), reviewPromptVersion: varchar('review_prompt_version', { length: 80 }), reviewErrorCode: varchar('review_error_code', { length: 80 }), analyzedAt: timestamp('analyzed_at', { withTimezone: true }), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const workspaceRecruitmentSchedules = pgTable('workspace_recruitment_schedules', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), applicationId: integer('application_id'), sourceMailCandidateId: integer('source_mail_candidate_id').references(() => workspaceMailCandidates.id, { onDelete: 'set null' }), eventType: varchar('event_type', { length: 32 }).notNull(), title: text('title').notNull(), company: text('company').notNull().default(''), position: text('position').notNull().default(''), timeMode: varchar('time_mode', { length: 32 }).notNull(), scheduledAt: varchar('scheduled_at', { length: 16 }), windowStartAt: varchar('window_start_at', { length: 16 }), windowEndAt: varchar('window_end_at', { length: 16 }), deadlineAt: varchar('deadline_at', { length: 16 }), durationMinutes: integer('duration_minutes'), timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Shanghai'), location: text('location').notNull().default(''), meetingLink: text('meeting_link').notNull().default(''), actionLink: text('action_link').notNull().default(''), contact: text('contact').notNull().default(''), instructionsJson: text('instructions_json').notNull().default('[]'), status: varchar('status', { length: 16 }).notNull().default('active'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_recruitment_schedules_candidate_unique').on(table.sourceMailCandidateId), index('workspace_recruitment_schedules_workspace_time_idx').on(table.workspaceId, table.scheduledAt)])

export const workspaceMailStatusUpdates = pgTable('workspace_mail_status_updates', {
  sourceMailCandidateId: integer('source_mail_candidate_id').primaryKey().references(() => workspaceMailCandidates.id, { onDelete: 'cascade' }), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), applicationId: integer('application_id').notNull(), scheduleId: integer('schedule_id').notNull().references(() => workspaceRecruitmentSchedules.id, { onDelete: 'cascade' }), fromStatus: varchar('from_status', { length: 24 }).notNull(), toStatus: varchar('to_status', { length: 24 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const workspaceMailAutomationSettings = pgTable('workspace_mail_automation_settings', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }), enabled: boolean('enabled').notNull().default(false), runTime: varchar('run_time', { length: 5 }).notNull().default('09:00'), lastRunAt: timestamp('last_run_at', { withTimezone: true }), lastStatus: varchar('last_status', { length: 16 }).notNull().default('idle'), lastErrorCode: varchar('last_error_code', { length: 80 }), lastErrorMessage: text('last_error_message'), lastScannedCount: integer('last_scanned_count').notNull().default(0), lastAnalyzedCount: integer('last_analyzed_count').notNull().default(0), lastConfirmedCount: integer('last_confirmed_count').notNull().default(0), lastReviewCount: integer('last_review_count').notNull().default(0), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

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

/** 复盘正文属于工作区数据库，避免以服务器共享 Markdown 文件作为用户数据源。 */
export const workspaceInterviewReviews = pgTable('workspace_interview_reviews', {
  id: serial('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  interviewId: integer('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  source: varchar('source', { length: 24 }).notNull().default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('workspace_interview_reviews_interview_unique').on(table.interviewId),
  index('workspace_interview_reviews_workspace_updated_idx').on(table.workspaceId, table.updatedAt)
])

export const workspaceRecordings = pgTable('workspace_recordings', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), interviewId: integer('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }), filename: text('filename').notNull(), storedName: varchar('stored_name', { length: 160 }).notNull(), size: integer('size').notNull(), status: varchar('status', { length: 24 }).notNull().default('uploading'), transcript: text('transcript'), knowledgeSourceId: integer('knowledge_source_id').references(() => knowledgeSources.id, { onDelete: 'set null' }), analysisJson: text('analysis_json'), analysisStage: varchar('analysis_stage', { length: 80 }).notNull().default('uploading'), attempts: integer('attempts').notNull().default(0), error: text('error'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_recordings_stored_name_unique').on(table.workspaceId, table.storedName), index('workspace_recordings_workspace_created_idx').on(table.workspaceId, table.createdAt), index('workspace_recordings_workspace_interview_idx').on(table.workspaceId, table.interviewId)])

export const workspaceRecordingAnalysisChunks = pgTable('workspace_recording_analysis_chunks', {
  recordingId: integer('recording_id').notNull().references(() => workspaceRecordings.id, { onDelete: 'cascade' }), chunkIndex: integer('chunk_index').notNull(), startOffset: integer('start_offset').notNull(), endOffset: integer('end_offset').notNull(), status: varchar('status', { length: 16 }).notNull().default('pending'), resultJson: text('result_json'), error: text('error'), attempts: integer('attempts').notNull().default(0), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [primaryKey({ columns: [table.recordingId, table.chunkIndex], name: 'workspace_recording_analysis_chunks_pkey' })])

/** 面试准备 Agent 的中间分析、运行步骤和确认后的计划均独立于旧 SQLite。 */
export const workspacePrepAgentRuns = pgTable('workspace_prep_agent_runs', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), threadId: varchar('thread_id', { length: 80 }).notNull(), requestId: varchar('request_id', { length: 100 }).notNull(), applicationId: integer('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }), interviewId: integer('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }), status: varchar('status', { length: 24 }).notNull().default('pending'), goal: text('goal').notNull(), constraintsJson: text('constraints_json').notNull().default('{}'), inputHash: varchar('input_hash', { length: 64 }).notNull(), snapshotHash: varchar('snapshot_hash', { length: 64 }), currentNode: varchar('current_node', { length: 80 }), planJson: text('plan_json'), evidenceJson: text('evidence_json'), roleProfileJson: text('role_profile_json'), gapAnalysisJson: text('gap_analysis_json'), criticJson: text('critic_json'), warningsJson: text('warnings_json').notNull().default('[]'), errorType: varchar('error_type', { length: 80 }), errorMessage: text('error_message'), modelCalls: integer('model_calls').notNull().default(0), promptTokens: integer('prompt_tokens').notNull().default(0), completionTokens: integer('completion_tokens').notNull().default(0), totalTokens: integer('total_tokens').notNull().default(0), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp('finished_at', { withTimezone: true })
}, table => [uniqueIndex('workspace_prep_agent_runs_request_unique').on(table.workspaceId, table.requestId), index('workspace_prep_agent_runs_interview_idx').on(table.workspaceId, table.interviewId, table.createdAt)])

export const workspacePrepAgentSteps = pgTable('workspace_prep_agent_steps', {
  id: serial('id').primaryKey(), runId: uuid('run_id').notNull().references(() => workspacePrepAgentRuns.id, { onDelete: 'cascade' }), node: varchar('node', { length: 80 }).notNull(), attempt: integer('attempt').notNull(), status: varchar('status', { length: 24 }).notNull().default('running'), summary: text('summary'), inputHash: varchar('input_hash', { length: 64 }), outputHash: varchar('output_hash', { length: 64 }), durationMs: integer('duration_ms'), errorType: varchar('error_type', { length: 80 }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp('finished_at', { withTimezone: true })
}, table => [index('workspace_prep_agent_steps_run_idx').on(table.runId, table.id)])

export const workspacePrepAgentPlanItems = pgTable('workspace_prep_agent_plan_items', {
  id: serial('id').primaryKey(), runId: uuid('run_id').notNull().references(() => workspacePrepAgentRuns.id, { onDelete: 'cascade' }), checklistId: integer('checklist_id').references(() => checklistItems.id, { onDelete: 'set null' }), title: text('title').notNull(), category: varchar('category', { length: 32 }).notNull(), priority: varchar('priority', { length: 16 }).notNull(), estimatedMinutes: integer('estimated_minutes').notNull(), reason: text('reason').notNull(), successCriteria: text('success_criteria').notNull(), evidenceJson: text('evidence_json').notNull().default('[]'), sort: integer('sort').notNull()
}, table => [index('workspace_prep_agent_plan_items_run_idx').on(table.runId, table.sort)])

export const workspacePrepTaskSessions = pgTable('workspace_prep_task_sessions', {
  id: serial('id').primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), planItemId: integer('plan_item_id').notNull().references(() => workspacePrepAgentPlanItems.id, { onDelete: 'cascade' }), guideJson: text('guide_json'), progressJson: text('progress_json').notNull().default('{"steps":[],"checks":[]}'), guideModel: varchar('guide_model', { length: 200 }), guideGeneratedAt: timestamp('guide_generated_at', { withTimezone: true }), guideVersion: integer('guide_version').notNull().default(0), generationStatus: varchar('generation_status', { length: 16 }).notNull().default('idle'), generationStage: varchar('generation_stage', { length: 40 }), generationProgress: integer('generation_progress').notNull().default(0), generationError: text('generation_error'), generationStartedAt: timestamp('generation_started_at', { withTimezone: true }), generationModelCalls: integer('generation_model_calls').notNull().default(0), generationPromptTokens: integer('generation_prompt_tokens').notNull().default(0), generationCompletionTokens: integer('generation_completion_tokens').notNull().default(0), generationTotalTokens: integer('generation_total_tokens').notNull().default(0), qualityJson: text('quality_json'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_prep_task_sessions_plan_item_unique').on(table.planItemId), index('workspace_prep_task_sessions_workspace_updated_idx').on(table.workspaceId, table.updatedAt)])

export const workspacePrepTaskMessages = pgTable('workspace_prep_task_messages', {
  id: serial('id').primaryKey(), sessionId: integer('session_id').notNull().references(() => workspacePrepTaskSessions.id, { onDelete: 'cascade' }), role: varchar('role', { length: 16 }).notNull(), content: text('content').notNull(), requestId: varchar('request_id', { length: 100 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [uniqueIndex('workspace_prep_task_messages_request_unique').on(table.sessionId, table.role, table.requestId), index('workspace_prep_task_messages_session_created_idx').on(table.sessionId, table.createdAt, table.id)])

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

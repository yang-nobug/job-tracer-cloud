-- 批量智能导入的基础：原文先生成可审阅的计划；正文按章节存储，禁止原样盲目拼接。
CREATE TABLE study_document_sections (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES study_document_sections(id) ON DELETE CASCADE,
  title VARCHAR(240) NOT NULL,
  canonical_key VARCHAR(240),
  content TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX study_document_sections_document_sort_idx ON study_document_sections(document_id, sort, id);
CREATE INDEX study_document_sections_parent_sort_idx ON study_document_sections(parent_id, sort, id);
CREATE TABLE study_import_jobs (
  id SERIAL PRIMARY KEY, workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  visibility VARCHAR(16) NOT NULL, source_text TEXT NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'planned',
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX study_import_jobs_workspace_created_idx ON study_import_jobs(workspace_id, created_at);
CREATE TABLE study_import_items (
  id SERIAL PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES study_import_jobs(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0, status VARCHAR(24) NOT NULL DEFAULT 'planned', action VARCHAR(32) NOT NULL,
  directory_key VARCHAR(48) NOT NULL, book_title VARCHAR(160) NOT NULL, path_json TEXT NOT NULL DEFAULT '[]',
  document_title VARCHAR(240) NOT NULL, summary TEXT NOT NULL DEFAULT '', sections_json TEXT NOT NULL DEFAULT '[]',
  target_document_id INTEGER REFERENCES study_documents(id) ON DELETE SET NULL, match_confidence INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX study_import_items_job_sort_idx ON study_import_items(job_id, sort, id);

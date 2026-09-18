-- 八股图解保存在私有 OSS；数据库只保存对象键和访问控制所需元数据。
CREATE TABLE study_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id INTEGER NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
  section_id INTEGER REFERENCES study_document_sections(id) ON DELETE SET NULL, object_key TEXT NOT NULL UNIQUE,
  original_name VARCHAR(240) NOT NULL, mime VARCHAR(80) NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  content_hash VARCHAR(64) NOT NULL, alt VARCHAR(500) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX study_assets_document_idx ON study_assets(document_id, created_at);

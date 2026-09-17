-- 八股正文文章与题卡分离：文章用于阅读，题卡用于练习与掌握度记录。
CREATE TABLE study_documents (
  id SERIAL PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES study_chapters(id) ON DELETE CASCADE,
  title VARCHAR(240) NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  source_name VARCHAR(240),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX study_documents_chapter_sort_idx ON study_documents(chapter_id, sort, id);

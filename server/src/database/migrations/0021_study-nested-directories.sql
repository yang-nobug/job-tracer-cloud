-- 八股目录不再限制为单层章节。已有章节保持为顶层目录，数据无需搬迁。
ALTER TABLE study_chapters
  ADD COLUMN parent_id INTEGER REFERENCES study_chapters(id) ON DELETE CASCADE;

CREATE INDEX study_chapters_parent_sort_idx
  ON study_chapters(parent_id, sort, id);

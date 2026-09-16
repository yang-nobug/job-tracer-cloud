-- 八股学习资料库：公共八股册与工作区私有八股册共用同一套章节、题目结构；
-- 熟悉度和笔记只属于具体用户，不产生任何待复习或自动提醒。
CREATE TABLE study_books (
  id SERIAL PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  visibility VARCHAR(16) NOT NULL DEFAULT 'private',
  directory_key VARCHAR(48) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT study_books_visibility_check CHECK (
    (visibility = 'public' AND workspace_id IS NULL) OR
    (visibility = 'private' AND workspace_id IS NOT NULL)
  )
);

CREATE INDEX study_books_directory_idx ON study_books(directory_key, visibility, id);
CREATE INDEX study_books_workspace_idx ON study_books(workspace_id, updated_at DESC);

CREATE TABLE study_chapters (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES study_books(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX study_chapters_book_sort_idx ON study_chapters(book_id, sort, id);

CREATE TABLE study_cards (
  id SERIAL PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES study_chapters(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  followups_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  difficulty VARCHAR(16) NOT NULL DEFAULT '基础',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX study_cards_chapter_sort_idx ON study_cards(chapter_id, sort, id);

CREATE TABLE study_card_progress (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES study_cards(id) ON DELETE CASCADE,
  familiarity INTEGER NOT NULL DEFAULT 0 CHECK (familiarity BETWEEN 0 AND 2),
  note TEXT NOT NULL DEFAULT '',
  last_opened_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_id)
);

CREATE INDEX study_card_progress_user_familiarity_idx ON study_card_progress(user_id, familiarity, updated_at DESC);

CREATE TABLE "workspace_project_profiles" (
  "id" serial PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(200) NOT NULL, "description" text NOT NULL DEFAULT '', "archive_filename" text NOT NULL, "archive_stored_name" varchar(160) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'ready', "scan_scopes_json" text NOT NULL DEFAULT '["."]', "files_seen" integer NOT NULL DEFAULT 0, "files_indexed" integer NOT NULL DEFAULT 0, "bytes_read" integer NOT NULL DEFAULT 0, "truncated" boolean NOT NULL DEFAULT false, "skipped_json" text NOT NULL DEFAULT '{}', "scanned_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspace_project_profiles_archive_unique" ON "workspace_project_profiles" ("workspace_id", "archive_stored_name");
CREATE INDEX "workspace_project_profiles_workspace_updated_idx" ON "workspace_project_profiles" ("workspace_id", "updated_at");
CREATE TABLE "workspace_project_files" (
  "id" serial PRIMARY KEY, "project_id" integer NOT NULL REFERENCES "workspace_project_profiles"("id") ON DELETE CASCADE, "relative_path" text NOT NULL, "language" varchar(32) NOT NULL, "size_bytes" integer NOT NULL, "line_count" integer NOT NULL, "content_hash" varchar(64) NOT NULL, "indexed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspace_project_files_path_unique" ON "workspace_project_files" ("project_id", "relative_path");
CREATE INDEX "workspace_project_files_project_path_idx" ON "workspace_project_files" ("project_id", "relative_path");
CREATE TABLE "workspace_project_chunks" (
  "id" serial PRIMARY KEY, "project_id" integer NOT NULL REFERENCES "workspace_project_profiles"("id") ON DELETE CASCADE, "file_id" integer NOT NULL REFERENCES "workspace_project_files"("id") ON DELETE CASCADE, "start_line" integer NOT NULL, "end_line" integer NOT NULL, "content" text NOT NULL, "content_hash" varchar(64) NOT NULL
);
CREATE INDEX "workspace_project_chunks_project_file_idx" ON "workspace_project_chunks" ("project_id", "file_id");
CREATE TABLE "workspace_project_facts" (
  "id" serial PRIMARY KEY, "project_id" integer NOT NULL REFERENCES "workspace_project_profiles"("id") ON DELETE CASCADE, "fact_type" varchar(40) NOT NULL, "title" varchar(300) NOT NULL, "content" text NOT NULL, "evidence_chunk_ids_json" text NOT NULL DEFAULT '[]', "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "workspace_project_facts_project_idx" ON "workspace_project_facts" ("project_id", "id");

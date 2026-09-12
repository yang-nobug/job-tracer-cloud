CREATE TABLE "workspace_recordings" (
  "id" serial PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "interview_id" integer NOT NULL REFERENCES "interviews"("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "stored_name" varchar(160) NOT NULL,
  "size" integer NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'uploading',
  "transcript" text,
  "knowledge_source_id" integer REFERENCES "knowledge_sources"("id") ON DELETE SET NULL,
  "analysis_json" text,
  "analysis_stage" varchar(80) NOT NULL DEFAULT 'uploading',
  "attempts" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspace_recordings_stored_name_unique" ON "workspace_recordings" ("workspace_id", "stored_name");
CREATE INDEX "workspace_recordings_workspace_created_idx" ON "workspace_recordings" ("workspace_id", "created_at");
CREATE INDEX "workspace_recordings_workspace_interview_idx" ON "workspace_recordings" ("workspace_id", "interview_id");

CREATE TABLE "workspace_recording_analysis_chunks" (
  "recording_id" integer NOT NULL REFERENCES "workspace_recordings"("id") ON DELETE CASCADE,
  "chunk_index" integer NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "result_json" text,
  "error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("recording_id", "chunk_index")
);

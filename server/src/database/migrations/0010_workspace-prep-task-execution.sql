CREATE TABLE "workspace_prep_task_sessions" (
  "id" serial PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "plan_item_id" integer NOT NULL REFERENCES "workspace_prep_agent_plan_items"("id") ON DELETE CASCADE,
  "guide_json" text,
  "progress_json" text NOT NULL DEFAULT '{"steps":[],"checks":[]}',
  "guide_model" varchar(200),
  "guide_generated_at" timestamptz,
  "guide_version" integer NOT NULL DEFAULT 0,
  "generation_status" varchar(16) NOT NULL DEFAULT 'idle',
  "generation_stage" varchar(40),
  "generation_progress" integer NOT NULL DEFAULT 0,
  "generation_error" text,
  "generation_started_at" timestamptz,
  "generation_model_calls" integer NOT NULL DEFAULT 0,
  "generation_prompt_tokens" integer NOT NULL DEFAULT 0,
  "generation_completion_tokens" integer NOT NULL DEFAULT 0,
  "generation_total_tokens" integer NOT NULL DEFAULT 0,
  "quality_json" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspace_prep_task_sessions_plan_item_unique" ON "workspace_prep_task_sessions" ("plan_item_id");
CREATE INDEX "workspace_prep_task_sessions_workspace_updated_idx" ON "workspace_prep_task_sessions" ("workspace_id", "updated_at");

CREATE TABLE "workspace_prep_task_messages" (
  "id" serial PRIMARY KEY,
  "session_id" integer NOT NULL REFERENCES "workspace_prep_task_sessions"("id") ON DELETE CASCADE,
  "role" varchar(16) NOT NULL,
  "content" text NOT NULL,
  "request_id" varchar(100) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspace_prep_task_messages_request_unique" ON "workspace_prep_task_messages" ("session_id", "role", "request_id");
CREATE INDEX "workspace_prep_task_messages_session_created_idx" ON "workspace_prep_task_messages" ("session_id", "created_at", "id");

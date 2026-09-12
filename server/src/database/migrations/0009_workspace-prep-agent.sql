CREATE TABLE "workspace_prep_agent_runs" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "thread_id" varchar(80) NOT NULL,
  "request_id" varchar(100) NOT NULL,
  "application_id" integer NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "interview_id" integer NOT NULL REFERENCES "interviews"("id") ON DELETE CASCADE,
  "status" varchar(24) NOT NULL DEFAULT 'pending',
  "goal" text NOT NULL,
  "constraints_json" text NOT NULL DEFAULT '{}',
  "input_hash" varchar(64) NOT NULL,
  "snapshot_hash" varchar(64),
  "current_node" varchar(80),
  "plan_json" text,
  "evidence_json" text,
  "role_profile_json" text,
  "gap_analysis_json" text,
  "critic_json" text,
  "warnings_json" text NOT NULL DEFAULT '[]',
  "error_type" varchar(80),
  "error_message" text,
  "model_calls" integer NOT NULL DEFAULT 0,
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
CREATE UNIQUE INDEX "workspace_prep_agent_runs_request_unique" ON "workspace_prep_agent_runs" ("workspace_id", "request_id");
CREATE INDEX "workspace_prep_agent_runs_interview_idx" ON "workspace_prep_agent_runs" ("workspace_id", "interview_id", "created_at");

CREATE TABLE "workspace_prep_agent_steps" (
  "id" serial PRIMARY KEY,
  "run_id" uuid NOT NULL REFERENCES "workspace_prep_agent_runs"("id") ON DELETE CASCADE,
  "node" varchar(80) NOT NULL,
  "attempt" integer NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'running',
  "summary" text,
  "input_hash" varchar(64),
  "output_hash" varchar(64),
  "duration_ms" integer,
  "error_type" varchar(80),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
CREATE INDEX "workspace_prep_agent_steps_run_idx" ON "workspace_prep_agent_steps" ("run_id", "id");

CREATE TABLE "workspace_prep_agent_plan_items" (
  "id" serial PRIMARY KEY,
  "run_id" uuid NOT NULL REFERENCES "workspace_prep_agent_runs"("id") ON DELETE CASCADE,
  "checklist_id" integer REFERENCES "checklist_items"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "category" varchar(32) NOT NULL,
  "priority" varchar(16) NOT NULL,
  "estimated_minutes" integer NOT NULL,
  "reason" text NOT NULL,
  "success_criteria" text NOT NULL,
  "evidence_json" text NOT NULL DEFAULT '[]',
  "sort" integer NOT NULL
);
CREATE INDEX "workspace_prep_agent_plan_items_run_idx" ON "workspace_prep_agent_plan_items" ("run_id", "sort");

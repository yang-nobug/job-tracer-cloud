CREATE TABLE "workspace_mail_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" varchar(16) NOT NULL,
  "email" varchar(320) NOT NULL,
  "host" varchar(160) NOT NULL,
  "port" integer NOT NULL,
  "secure" boolean NOT NULL DEFAULT true,
  "mailbox" varchar(160) NOT NULL DEFAULT 'INBOX',
  "credential_ref" varchar(180) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'connected',
  "last_tested_at" timestamptz,
  "last_error_code" varchar(80),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_mail_accounts_workspace_unique" UNIQUE("workspace_id")
);
CREATE TABLE "workspace_mail_sync_states" (
  "account_id" integer NOT NULL REFERENCES "workspace_mail_accounts"("id") ON DELETE CASCADE,
  "mailbox" varchar(160) NOT NULL,
  "uid_validity" varchar(80) NOT NULL,
  "last_uid" integer NOT NULL DEFAULT 0,
  "last_scanned_at" timestamptz,
  PRIMARY KEY("account_id", "mailbox")
);
CREATE TABLE "workspace_mail_candidates" (
  "id" serial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" integer NOT NULL REFERENCES "workspace_mail_accounts"("id") ON DELETE CASCADE,
  "mailbox" varchar(160) NOT NULL,
  "uid_validity" varchar(80) NOT NULL,
  "uid" integer NOT NULL,
  "subject" text NOT NULL,
  "sender" text NOT NULL,
  "sent_at" timestamptz,
  "is_read" boolean NOT NULL DEFAULT false,
  "score" integer NOT NULL DEFAULT 0,
  "matched_terms_json" text NOT NULL DEFAULT '[]',
  "status" varchar(16) NOT NULL DEFAULT 'candidate',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_mail_candidates_message_unique" UNIQUE("account_id", "mailbox", "uid_validity", "uid")
);
CREATE TABLE "workspace_mail_candidate_analyses" (
  "candidate_id" integer PRIMARY KEY NOT NULL REFERENCES "workspace_mail_candidates"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "status" varchar(16) NOT NULL,
  "extraction_json" text,
  "body_hash" varchar(64),
  "body_truncated" boolean NOT NULL DEFAULT false,
  "model" varchar(200),
  "prompt_version" varchar(80),
  "error_code" varchar(80),
  "schedule_review_json" text,
  "review_model" varchar(200),
  "review_prompt_version" varchar(80),
  "review_error_code" varchar(80),
  "analyzed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "workspace_recruitment_schedules" (
  "id" serial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "application_id" integer,
  "source_mail_candidate_id" integer UNIQUE REFERENCES "workspace_mail_candidates"("id") ON DELETE SET NULL,
  "event_type" varchar(32) NOT NULL,
  "title" text NOT NULL,
  "company" text NOT NULL DEFAULT '',
  "position" text NOT NULL DEFAULT '',
  "time_mode" varchar(32) NOT NULL,
  "scheduled_at" varchar(16),
  "window_start_at" varchar(16),
  "window_end_at" varchar(16),
  "deadline_at" varchar(16),
  "duration_minutes" integer,
  "timezone" varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  "location" text NOT NULL DEFAULT '',
  "meeting_link" text NOT NULL DEFAULT '',
  "action_link" text NOT NULL DEFAULT '',
  "contact" text NOT NULL DEFAULT '',
  "instructions_json" text NOT NULL DEFAULT '[]',
  "status" varchar(16) NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "workspace_mail_status_updates" (
  "source_mail_candidate_id" integer PRIMARY KEY NOT NULL REFERENCES "workspace_mail_candidates"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "application_id" integer NOT NULL,
  "schedule_id" integer NOT NULL REFERENCES "workspace_recruitment_schedules"("id") ON DELETE CASCADE,
  "from_status" varchar(24) NOT NULL,
  "to_status" varchar(24) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "workspace_mail_candidates_workspace_created_idx" ON "workspace_mail_candidates"("workspace_id", "created_at");
CREATE INDEX "workspace_recruitment_schedules_workspace_time_idx" ON "workspace_recruitment_schedules"("workspace_id", "scheduled_at");

CREATE TABLE "workspace_mail_automation_settings" (
  "workspace_id" uuid PRIMARY KEY NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "run_time" varchar(5) NOT NULL DEFAULT '09:00',
  "last_run_at" timestamptz,
  "last_status" varchar(16) NOT NULL DEFAULT 'idle',
  "last_error_code" varchar(80),
  "last_error_message" text,
  "last_scanned_count" integer NOT NULL DEFAULT 0,
  "last_analyzed_count" integer NOT NULL DEFAULT 0,
  "last_confirmed_count" integer NOT NULL DEFAULT 0,
  "last_review_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "platform_system_logs" (
  "id" serial PRIMARY KEY,
  "level" varchar(12) NOT NULL,
  "source" varchar(80) NOT NULL,
  "event_name" varchar(120) NOT NULL,
  "trace_id" varchar(100),
  "operation_run_id" integer,
  "operation_step_id" integer,
  "entity_type" varchar(100),
  "entity_id" varchar(200),
  "message" text NOT NULL,
  "context_json" text,
  "error_code" varchar(120),
  "error_stack" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "platform_system_logs_created_idx" ON "platform_system_logs" ("id" DESC);
CREATE INDEX "platform_system_logs_trace_idx" ON "platform_system_logs" ("trace_id","id" DESC);
CREATE INDEX "platform_system_logs_error_idx" ON "platform_system_logs" ("level","error_code","id" DESC);

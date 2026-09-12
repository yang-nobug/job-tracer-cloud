CREATE TABLE "workspace_tutor_sessions" (
  "id" serial PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "title" varchar(80) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "workspace_tutor_sessions_workspace_updated_idx" ON "workspace_tutor_sessions" ("workspace_id", "updated_at");

CREATE TABLE "workspace_tutor_messages" (
  "id" serial PRIMARY KEY,
  "session_id" integer NOT NULL REFERENCES "workspace_tutor_sessions"("id") ON DELETE CASCADE,
  "role" varchar(16) NOT NULL,
  "content" text NOT NULL,
  "request_id" varchar(100) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspace_tutor_messages_request_unique" ON "workspace_tutor_messages" ("session_id", "role", "request_id");
CREATE INDEX "workspace_tutor_messages_session_created_idx" ON "workspace_tutor_messages" ("session_id", "created_at", "id");

CREATE TABLE "workspace_tutor_message_citations" (
  "message_id" integer NOT NULL REFERENCES "workspace_tutor_messages"("id") ON DELETE CASCADE,
  "knowledge_item_id" integer NOT NULL REFERENCES "knowledge_items"("id") ON DELETE CASCADE,
  "citation_key" varchar(16) NOT NULL,
  "rank" integer NOT NULL,
  "score" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("message_id", "knowledge_item_id")
);
CREATE INDEX "workspace_tutor_message_citations_item_idx" ON "workspace_tutor_message_citations" ("knowledge_item_id");

CREATE TABLE "workspace_tutor_message_feedback" (
  "message_id" integer PRIMARY KEY REFERENCES "workspace_tutor_messages"("id") ON DELETE CASCADE,
  "value" integer NOT NULL CHECK ("value" IN (-1, 1)),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

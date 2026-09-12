CREATE TABLE "workspace_interview_reviews" (
  "id" serial PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "interview_id" integer NOT NULL REFERENCES "interviews"("id") ON DELETE CASCADE,
  "content" text NOT NULL,
  "source" varchar(24) NOT NULL DEFAULT 'manual',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspace_interview_reviews_interview_unique" ON "workspace_interview_reviews" ("interview_id");
CREATE INDEX "workspace_interview_reviews_workspace_updated_idx" ON "workspace_interview_reviews" ("workspace_id", "updated_at");

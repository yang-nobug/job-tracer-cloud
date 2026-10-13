-- 招聘日程是邮箱通知和手动录入共用的时间线；interviews 只保留准备、录音和复盘能力。
ALTER TABLE "workspace_recruitment_schedules"
  ADD COLUMN "source" varchar(16) NOT NULL DEFAULT 'mail',
  ADD COLUMN "round" varchar(40) NOT NULL DEFAULT '',
  ADD COLUMN "interview_id" integer UNIQUE REFERENCES "interviews"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "workspace_recruitment_schedules_workspace_application_idx"
  ON "workspace_recruitment_schedules" ("workspace_id", "application_id", "status");
--> statement-breakpoint

-- 已有手动面试/测评/笔试迁入统一日程，原 interviews 记录与其准备清单、录音、复盘均保留。
INSERT INTO "workspace_recruitment_schedules" (
  "workspace_id", "application_id", "interview_id", "source", "event_type", "round", "title",
  "company", "position", "time_mode", "scheduled_at", "location", "instructions_json", "status", "created_at", "updated_at"
)
SELECT
  i."workspace_id", i."application_id", i."id", 'manual',
  CASE i."round"
    WHEN '心理测评' THEN 'assessment'
    WHEN '笔试' THEN 'written_test'
    WHEN 'AI面' THEN 'ai_interview'
    ELSE 'interview'
  END,
  i."round", concat_ws(' · ', a."company", a."position", i."round"),
  a."company", a."position", 'fixed', i."scheduled_at", COALESCE(i."location", ''), '[]',
  CASE WHEN i."done" THEN 'completed' ELSE 'active' END,
  i."created_at", i."created_at"
FROM "interviews" i
JOIN "applications" a ON a."workspace_id"=i."workspace_id" AND a."id"=i."application_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "workspace_recruitment_schedules" s WHERE s."interview_id"=i."id"
);

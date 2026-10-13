-- 已经由邮箱识别保存、且具备固定时间和关联投递的事项，也补齐准备/录音/复盘入口。
-- 使用逐条循环保证相同公司、岗位和时间的多个日程仍各自拥有独立的准备记录。
DO $$
DECLARE
  schedule_row record;
  created_interview_id integer;
BEGIN
  FOR schedule_row IN
    SELECT id, workspace_id, application_id, round, event_type, scheduled_at, location
    FROM workspace_recruitment_schedules
    WHERE source = 'mail'
      AND application_id IS NOT NULL
      AND scheduled_at IS NOT NULL
      AND interview_id IS NULL
      AND event_type NOT IN ('offer', 'other')
  LOOP
    INSERT INTO interviews (workspace_id, application_id, round, scheduled_at, location)
    VALUES (
      schedule_row.workspace_id,
      schedule_row.application_id,
      LEFT(COALESCE(NULLIF(schedule_row.round, ''), CASE schedule_row.event_type
        WHEN 'assessment' THEN '在线测评'
        WHEN 'written_test' THEN '笔试'
        WHEN 'ai_interview' THEN 'AI 面试'
        ELSE '面试'
      END), 40),
      schedule_row.scheduled_at,
      NULLIF(schedule_row.location, '')
    )
    RETURNING id INTO created_interview_id;

    UPDATE workspace_recruitment_schedules
    SET interview_id = created_interview_id, updated_at = now()
    WHERE id = schedule_row.id;
  END LOOP;
END $$;

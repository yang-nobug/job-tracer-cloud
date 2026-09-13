ALTER TABLE "users" ADD COLUMN "shared_jobs_consent_at" timestamptz;
CREATE INDEX "users_shared_jobs_consent_idx" ON "users" ("shared_jobs_consent_at") WHERE "shared_jobs_consent_at" IS NOT NULL;

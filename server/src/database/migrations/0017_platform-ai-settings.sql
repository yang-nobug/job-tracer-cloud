CREATE TABLE "platform_ai_settings" (
  "key" varchar(100) PRIMARY KEY,
  "value" text NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "knowledge_sources" (
  "id" serial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "owner" varchar(16) DEFAULT 'others' NOT NULL,
  "company" text NOT NULL,
  "position" text,
  "round" varchar(40),
  "source_type" varchar(16) DEFAULT 'manual' NOT NULL,
  "note" text,
  "application_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_id" integer,
  "question" text NOT NULL,
  "answer" text,
  "category" varchar(32) DEFAULT '其他' NOT NULL,
  "sub_category" varchar(100),
  "mastery" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_images" (
  "id" serial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_id" integer NOT NULL,
  "filename" text NOT NULL,
  "stored_name" varchar(160) NOT NULL,
  "inference_stored_name" varchar(160),
  "inference_mime" varchar(80),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_answer_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "knowledge_item_id" integer NOT NULL,
  "answer" text NOT NULL,
  "reason" varchar(40) NOT NULL,
  "model" varchar(200),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_images" ADD CONSTRAINT "knowledge_images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_images" ADD CONSTRAINT "knowledge_images_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_answer_versions" ADD CONSTRAINT "knowledge_answer_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_answer_versions" ADD CONSTRAINT "knowledge_answer_versions_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "knowledge_sources_workspace_created_idx" ON "knowledge_sources" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "knowledge_sources_workspace_company_idx" ON "knowledge_sources" USING btree ("workspace_id","company");
--> statement-breakpoint
CREATE INDEX "knowledge_items_workspace_updated_idx" ON "knowledge_items" USING btree ("workspace_id","updated_at");
--> statement-breakpoint
CREATE INDEX "knowledge_items_workspace_source_idx" ON "knowledge_items" USING btree ("workspace_id","source_id");
--> statement-breakpoint
CREATE INDEX "knowledge_items_workspace_category_idx" ON "knowledge_items" USING btree ("workspace_id","category");
--> statement-breakpoint
CREATE INDEX "knowledge_items_workspace_mastery_idx" ON "knowledge_items" USING btree ("workspace_id","mastery");
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_images_workspace_stored_name_unique" ON "knowledge_images" USING btree ("workspace_id","stored_name");
--> statement-breakpoint
CREATE INDEX "knowledge_images_workspace_source_idx" ON "knowledge_images" USING btree ("workspace_id","source_id");
--> statement-breakpoint
CREATE INDEX "knowledge_answer_versions_workspace_item_idx" ON "knowledge_answer_versions" USING btree ("workspace_id","knowledge_item_id","id");

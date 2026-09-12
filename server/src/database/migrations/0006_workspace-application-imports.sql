CREATE TABLE "application_imports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "application_id" integer,
  "analysis_json" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_materials" (
  "id" varchar(40) NOT NULL,
  "import_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "kind" varchar(16) NOT NULL,
  "text_content" text,
  "filename" text,
  "stored_name" varchar(160),
  "mime" varchar(80),
  "captured_at" varchar(10),
  "inference_stored_name" varchar(160),
  "inference_mime" varchar(80)
);
--> statement-breakpoint
ALTER TABLE "application_materials" ADD CONSTRAINT "application_materials_pkey" PRIMARY KEY ("import_id","id");
--> statement-breakpoint
ALTER TABLE "application_imports" ADD CONSTRAINT "application_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_materials" ADD CONSTRAINT "application_materials_import_id_application_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."application_imports"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_materials" ADD CONSTRAINT "application_materials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "application_imports_workspace_created_idx" ON "application_imports" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "application_imports_workspace_application_idx" ON "application_imports" USING btree ("workspace_id","application_id");
--> statement-breakpoint
CREATE INDEX "application_materials_workspace_import_idx" ON "application_materials" USING btree ("workspace_id","import_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "application_materials_workspace_stored_name_unique" ON "application_materials" USING btree ("workspace_id","stored_name");

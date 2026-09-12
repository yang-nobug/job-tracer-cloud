CREATE TABLE "legacy_core_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"source_label" text NOT NULL,
	"applications_count" integer DEFAULT 0 NOT NULL,
	"events_count" integer DEFAULT 0 NOT NULL,
	"interviews_count" integer DEFAULT 0 NOT NULL,
	"checklist_items_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_core_imports" ADD CONSTRAINT "legacy_core_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_core_imports_workspace_unique" ON "legacy_core_imports" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_core_imports_source_hash_unique" ON "legacy_core_imports" USING btree ("source_hash");
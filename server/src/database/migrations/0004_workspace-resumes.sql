CREATE TABLE "resume_texts" (
	"resume_id" integer PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"text_content" text,
	"content_hash" varchar(64),
	"error_message" text,
	"extraction_method" varchar(24),
	"model" varchar(200),
	"page_count" integer,
	"pages_completed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"extracted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"stored_name" varchar(160) NOT NULL,
	"size" integer NOT NULL,
	"note" varchar(80),
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "resume_id" integer;--> statement-breakpoint
ALTER TABLE "resume_texts" ADD CONSTRAINT "resume_texts_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_texts" ADD CONSTRAINT "resume_texts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_texts_workspace_status_idx" ON "resume_texts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "resumes_workspace_stored_name_unique" ON "resumes" USING btree ("workspace_id","stored_name");--> statement-breakpoint
CREATE INDEX "resumes_workspace_uploaded_idx" ON "resumes" USING btree ("workspace_id","uploaded_at");
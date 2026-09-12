CREATE TABLE "application_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" integer NOT NULL,
	"type" varchar(24) NOT NULL,
	"event_date" varchar(10) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company" text NOT NULL,
	"position" text NOT NULL,
	"status" varchar(24) DEFAULT 'unsent' NOT NULL,
	"applied_at" varchar(10),
	"applied_time" varchar(8),
	"channel" text,
	"location" text,
	"jd_link" text,
	"application_link" text,
	"jd_text" text,
	"contact_name" text,
	"contact_info" text,
	"notes" text,
	"rejected_at" varchar(10),
	"reject_type" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"interview_id" integer NOT NULL,
	"content" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" integer NOT NULL,
	"round" varchar(40) NOT NULL,
	"scheduled_at" varchar(16) NOT NULL,
	"location" text,
	"review_file" text,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_workspace_application_idx" ON "application_events" USING btree ("workspace_id","application_id","event_date");--> statement-breakpoint
CREATE INDEX "applications_workspace_updated_idx" ON "applications" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "applications_workspace_status_idx" ON "applications" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "applications_workspace_company_idx" ON "applications" USING btree ("workspace_id","company");--> statement-breakpoint
CREATE INDEX "checklist_items_workspace_interview_idx" ON "checklist_items" USING btree ("workspace_id","interview_id","sort");--> statement-breakpoint
CREATE INDEX "interviews_workspace_time_idx" ON "interviews" USING btree ("workspace_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "interviews_workspace_application_idx" ON "interviews" USING btree ("workspace_id","application_id");
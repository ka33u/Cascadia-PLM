CREATE TABLE "account_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_id" uuid,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"name" varchar(100) NOT NULL,
	"password_hash" text,
	"active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(200) NOT NULL,
	"customer" text,
	"description" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_end_date" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "npi_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"tracking_item_id" uuid,
	"issue_id" uuid,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"file_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"category" varchar(30) NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	CONSTRAINT "npi_attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "npi_attachment_request" UNIQUE("uploaded_by","request_id")
);
--> statement-breakpoint
CREATE TABLE "npi_bom_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"template_id" text NOT NULL,
	"mother" jsonb NOT NULL,
	"sheet_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"max_level" integer NOT NULL,
	"source_name" text NOT NULL,
	"source_base64" text NOT NULL,
	"source_hash" text NOT NULL,
	"template_snapshot" jsonb NOT NULL,
	"imported_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npi_bom_program_version" UNIQUE("program_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "npi_bom_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"parent_id" uuid,
	"level" integer NOT NULL,
	"material_code" text NOT NULL,
	"row" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npi_bom_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_version" integer NOT NULL,
	"template_id" text NOT NULL,
	"preview" jsonb NOT NULL,
	"source_name" text NOT NULL,
	"source_base64" text NOT NULL,
	"source_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_import_id" uuid,
	"saved_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"draft_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npi_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid,
	"object_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npi_import_templates" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npi_issue_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"comments" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npi_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"number" text NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"severity" varchar(20) DEFAULT 'Medium' NOT NULL,
	"state" varchar(30) DEFAULT 'Open' NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"target_date" date NOT NULL,
	"tracking_item_id" uuid,
	"bom_item_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npi_issues_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "npi_manufacturing_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "npi_manufacturing_plan_program_id_unique" UNIQUE("program_id")
);
--> statement-breakpoint
CREATE TABLE "npi_projects" (
	"program_id" uuid PRIMARY KEY NOT NULL,
	"motor_model" varchar(150) NOT NULL,
	"technical_owner_id" uuid NOT NULL,
	"manufacturing_owner_id" uuid NOT NULL,
	"drawing_complete_date" date,
	"required_kit_date" date NOT NULL,
	"prototype_required_date" date NOT NULL,
	"current_npi_stage" varchar(30) DEFAULT 'design' NOT NULL,
	"active_bom_import_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npi_promise_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"old_committed_date" date,
	"new_committed_date" date NOT NULL,
	"reason" text NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npi_tracking_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"bom_item_id" uuid,
	"manufacturing_plan_id" uuid,
	"source_type" text NOT NULL,
	"tracking_type" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"specification" text DEFAULT '' NOT NULL,
	"qty" text DEFAULT '1' NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"required_date" date NOT NULL,
	"first_committed_date" date,
	"current_committed_date" date,
	"actual_complete_date" date,
	"affects_kit" boolean DEFAULT true NOT NULL,
	"tracking_enabled" boolean DEFAULT true NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"remark" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npi_tracking_bom_unique" UNIQUE("bom_item_id"),
	CONSTRAINT "npi_node_unique" UNIQUE("manufacturing_plan_id","tracking_type")
);
--> statement-breakpoint
CREATE TABLE "npi_user_roles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" varchar(30) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD CONSTRAINT "npi_attachments_program_id_npi_projects_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."npi_projects"("program_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD CONSTRAINT "npi_attachments_tracking_item_id_npi_tracking_items_id_fk" FOREIGN KEY ("tracking_item_id") REFERENCES "public"."npi_tracking_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD CONSTRAINT "npi_attachments_issue_id_npi_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."npi_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD CONSTRAINT "npi_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD CONSTRAINT "npi_attachments_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_bom_imports" ADD CONSTRAINT "npi_bom_imports_program_id_projects_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_bom_imports" ADD CONSTRAINT "npi_bom_imports_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_bom_items" ADD CONSTRAINT "npi_bom_items_import_id_npi_bom_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."npi_bom_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_bom_items" ADD CONSTRAINT "npi_bom_items_parent_id_npi_bom_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."npi_bom_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_bom_previews" ADD CONSTRAINT "npi_bom_previews_program_id_projects_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_bom_previews" ADD CONSTRAINT "npi_bom_previews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_bom_previews" ADD CONSTRAINT "npi_bom_previews_draft_source_id_npi_bom_previews_id_fk" FOREIGN KEY ("draft_source_id") REFERENCES "public"."npi_bom_previews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_events" ADD CONSTRAINT "npi_events_program_id_projects_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_events" ADD CONSTRAINT "npi_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_import_templates" ADD CONSTRAINT "npi_import_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issue_history" ADD CONSTRAINT "npi_issue_history_issue_id_npi_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."npi_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issue_history" ADD CONSTRAINT "npi_issue_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issues" ADD CONSTRAINT "npi_issues_program_id_npi_projects_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."npi_projects"("program_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issues" ADD CONSTRAINT "npi_issues_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issues" ADD CONSTRAINT "npi_issues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issues" ADD CONSTRAINT "npi_issues_tracking_item_id_npi_tracking_items_id_fk" FOREIGN KEY ("tracking_item_id") REFERENCES "public"."npi_tracking_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issues" ADD CONSTRAINT "npi_issues_bom_item_id_npi_bom_items_id_fk" FOREIGN KEY ("bom_item_id") REFERENCES "public"."npi_bom_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_manufacturing_plan" ADD CONSTRAINT "npi_manufacturing_plan_program_id_projects_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_manufacturing_plan" ADD CONSTRAINT "npi_manufacturing_plan_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_projects" ADD CONSTRAINT "npi_projects_program_id_projects_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_projects" ADD CONSTRAINT "npi_projects_technical_owner_id_users_id_fk" FOREIGN KEY ("technical_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_projects" ADD CONSTRAINT "npi_projects_manufacturing_owner_id_users_id_fk" FOREIGN KEY ("manufacturing_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_projects" ADD CONSTRAINT "npi_projects_active_bom_import_id_npi_bom_imports_id_fk" FOREIGN KEY ("active_bom_import_id") REFERENCES "public"."npi_bom_imports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_promise_history" ADD CONSTRAINT "npi_promise_history_program_id_projects_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_promise_history" ADD CONSTRAINT "npi_promise_history_object_id_npi_tracking_items_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."npi_tracking_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_promise_history" ADD CONSTRAINT "npi_promise_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_tracking_items" ADD CONSTRAINT "npi_tracking_items_program_id_projects_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_tracking_items" ADD CONSTRAINT "npi_tracking_items_bom_item_id_npi_bom_items_id_fk" FOREIGN KEY ("bom_item_id") REFERENCES "public"."npi_bom_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_tracking_items" ADD CONSTRAINT "npi_tracking_items_manufacturing_plan_id_npi_manufacturing_plan_id_fk" FOREIGN KEY ("manufacturing_plan_id") REFERENCES "public"."npi_manufacturing_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_tracking_items" ADD CONSTRAINT "npi_tracking_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_user_roles" ADD CONSTRAINT "npi_user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npi_attachment_project" ON "npi_attachments" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "npi_bom_import_level" ON "npi_bom_items" USING btree ("import_id","level");--> statement-breakpoint
CREATE INDEX "npi_bom_parent" ON "npi_bom_items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "npi_issue_project" ON "npi_issues" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "npi_issue_owner" ON "npi_issues" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "npi_history_object" ON "npi_promise_history" USING btree ("object_id","changed_at");--> statement-breakpoint
CREATE INDEX "npi_owner_project" ON "npi_tracking_items" USING btree ("owner_id","program_id");
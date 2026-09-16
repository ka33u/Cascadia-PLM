CREATE TABLE "npi_document_spaces" (
	"program_id" uuid PRIMARY KEY NOT NULL,
	"design_id" uuid NOT NULL,
	CONSTRAINT "npi_document_spaces_design_id_unique" UNIQUE("design_id")
);
--> statement-breakpoint
CREATE TABLE "npi_file_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"tracking_item_id" uuid,
	"issue_id" uuid,
	"category" varchar(30) NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	CONSTRAINT "npi_file_links_document_id_unique" UNIQUE("document_id"),
	CONSTRAINT "npi_file_links_file_id_unique" UNIQUE("file_id"),
	CONSTRAINT "npi_file_upload_request" UNIQUE("uploaded_by","request_id")
);
--> statement-breakpoint
ALTER TABLE "npi_document_spaces" ADD CONSTRAINT "npi_document_spaces_program_id_npi_projects_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."npi_projects"("program_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_document_spaces" ADD CONSTRAINT "npi_document_spaces_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_file_links" ADD CONSTRAINT "npi_file_links_program_id_npi_projects_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."npi_projects"("program_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_file_links" ADD CONSTRAINT "npi_file_links_document_id_documents_item_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_file_links" ADD CONSTRAINT "npi_file_links_file_id_vault_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vault_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_file_links" ADD CONSTRAINT "npi_file_links_tracking_item_id_npi_tracking_items_id_fk" FOREIGN KEY ("tracking_item_id") REFERENCES "public"."npi_tracking_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_file_links" ADD CONSTRAINT "npi_file_links_issue_id_npi_issue_links_item_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."npi_issue_links"("item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_file_links" ADD CONSTRAINT "npi_file_links_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_file_links" ADD CONSTRAINT "npi_file_links_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npi_file_project" ON "npi_file_links" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "npi_file_tracking" ON "npi_file_links" USING btree ("tracking_item_id");--> statement-breakpoint
CREATE INDEX "npi_file_issue" ON "npi_file_links" USING btree ("issue_id");
CREATE TABLE "npi_issue_links" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"program_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"tracking_item_id" uuid,
	"bom_item_id" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "npi_issue_links" ADD CONSTRAINT "npi_issue_links_item_id_issues_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issue_links" ADD CONSTRAINT "npi_issue_links_program_id_npi_projects_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."npi_projects"("program_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issue_links" ADD CONSTRAINT "npi_issue_links_tracking_item_id_npi_tracking_items_id_fk" FOREIGN KEY ("tracking_item_id") REFERENCES "public"."npi_tracking_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_issue_links" ADD CONSTRAINT "npi_issue_links_bom_item_id_npi_bom_items_id_fk" FOREIGN KEY ("bom_item_id") REFERENCES "public"."npi_bom_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npi_issue_project" ON "npi_issue_links" USING btree ("program_id");
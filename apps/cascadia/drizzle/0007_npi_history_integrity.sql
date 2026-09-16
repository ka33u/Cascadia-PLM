ALTER TABLE "npi_projects" DROP CONSTRAINT "npi_projects_program_id_programs_id_fk";
--> statement-breakpoint
ALTER TABLE "npi_promise_history" DROP CONSTRAINT "npi_promise_history_object_id_npi_tracking_items_id_fk";
--> statement-breakpoint
ALTER TABLE "npi_bom_items" ADD CONSTRAINT "npi_bom_items_parent_id_npi_bom_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."npi_bom_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_projects" ADD CONSTRAINT "npi_projects_active_bom_import_id_npi_bom_imports_id_fk" FOREIGN KEY ("active_bom_import_id") REFERENCES "public"."npi_bom_imports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_projects" ADD CONSTRAINT "npi_projects_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_promise_history" ADD CONSTRAINT "npi_promise_history_object_id_npi_tracking_items_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."npi_tracking_items"("id") ON DELETE restrict ON UPDATE no action;
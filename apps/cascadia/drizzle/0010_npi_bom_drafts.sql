ALTER TABLE "npi_bom_previews" ADD COLUMN "saved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "npi_bom_previews" ADD COLUMN "discarded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "npi_bom_previews" ADD COLUMN "draft_source_id" uuid REFERENCES "npi_bom_previews"("id");

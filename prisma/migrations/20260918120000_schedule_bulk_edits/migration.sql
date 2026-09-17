-- Scheduled bulk edits: a scheduled job is either a draft publish ("publish",
-- the existing rows) or the bulk editor's pending per-listing changes
-- ("bulk_edit"), which the runner applies through the same write path Sync
-- updates uses. `results` holds the per-listing outcomes of the last pass.
ALTER TABLE "scheduled_listings" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'publish';
ALTER TABLE "scheduled_listings" ADD COLUMN "bulkEdit" JSONB;
ALTER TABLE "scheduled_listings" ADD COLUMN "results" JSONB;

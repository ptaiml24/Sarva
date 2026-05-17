-- Count review ↔ fix loops (human or automated reviewer returning work to implementer).

ALTER TABLE "task" ADD COLUMN "review_revision_count" INTEGER NOT NULL DEFAULT 0;

-- Ordered execution: lower phases must complete (state = done) before tasks in higher phases can be claimed.
ALTER TABLE "task" ADD COLUMN "execution_phase" INTEGER NOT NULL DEFAULT 0;

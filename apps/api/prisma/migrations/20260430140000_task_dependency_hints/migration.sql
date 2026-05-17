-- Pending predecessor titles from PM propose (resolved to task_dependency when titles match).
ALTER TABLE "task" ADD COLUMN "dependency_hints" JSONB;

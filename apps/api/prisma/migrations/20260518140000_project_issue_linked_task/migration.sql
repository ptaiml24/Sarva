-- Optional link from project_issue to the delivery Task created to fix this issue.

ALTER TABLE "project_issue" ADD COLUMN "linked_task_id" UUID;

ALTER TABLE "project_issue" ADD CONSTRAINT "project_issue_linked_task_id_fkey" FOREIGN KEY ("linked_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "project_issue_linked_task_id_key" ON "project_issue"("linked_task_id");

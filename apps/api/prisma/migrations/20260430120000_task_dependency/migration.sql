-- Task finish-to-start links: successor cannot be claimed until all predecessors are `done`.
CREATE TABLE "task_dependency" (
    "successor_task_id" UUID NOT NULL,
    "predecessor_task_id" UUID NOT NULL,

    CONSTRAINT "task_dependency_pkey" PRIMARY KEY ("successor_task_id","predecessor_task_id"),
    CONSTRAINT "task_dependency_successor_task_id_fkey" FOREIGN KEY ("successor_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_dependency_predecessor_task_id_fkey" FOREIGN KEY ("predecessor_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "task_dependency_predecessor_task_id_idx" ON "task_dependency"("predecessor_task_id");

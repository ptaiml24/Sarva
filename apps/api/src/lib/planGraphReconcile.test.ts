import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./prisma.js";
import { reconcilePredecessorPhasesForProject } from "./planGraphReconcile.js";

describe("reconcilePredecessorPhasesForProject", () => {
  let projectId: string;
  let predId: string;
  let succId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: { name: `vitest-reconcile-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = project.id;

    const pred = await prisma.task.create({
      data: {
        projectId,
        title: "Later wave prerequisite",
        state: "backlog",
        executionPhase: 5,
        version: 1,
      },
    });
    predId = pred.id;

    const succ = await prisma.task.create({
      data: {
        projectId,
        title: "Earlier wave successor",
        state: "backlog",
        executionPhase: 2,
        version: 1,
      },
    });
    succId = succ.id;

    await prisma.taskDependency.create({
      data: { successorTaskId: succId, predecessorTaskId: predId },
    });
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  it("lowers predecessor waves so prerequisite phase ≤ successor on every edge", async () => {
    const { adjustedTaskIds } = await reconcilePredecessorPhasesForProject(projectId, { silent: true });
    expect(adjustedTaskIds).toContain(predId);

    const pred = await prisma.task.findUniqueOrThrow({ where: { id: predId } });
    const succ = await prisma.task.findUniqueOrThrow({ where: { id: succId } });
    expect(pred.executionPhase).toBeLessThanOrEqual(succ.executionPhase);
    expect(pred.executionPhase).toBe(2);
  });

  it("is a no-op on the second pass", async () => {
    const second = await reconcilePredecessorPhasesForProject(projectId, { silent: true });
    expect(second.adjustedTaskIds.length).toBe(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./prisma.js";
import { promoteEligibleAndAutoStartInTx } from "./deliveryOrchestration.js";

describe("deliveryOrchestration phase promotion", () => {
  let projectId: string;

  beforeAll(async () => {
    const p = await prisma.project.create({
      data: { name: `vitest-orch-${Date.now()}`, repoAssociationMode: "dedicated_repo" },
    });
    projectId = p.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  it("promotes only phase 0 from backlog while phase 1 stays backlog", async () => {
    await prisma.task.deleteMany({ where: { projectId } });
    const a = await prisma.task.create({
      data: { projectId, title: "p0", state: "backlog", executionPhase: 0, version: 1 },
    });
    const b = await prisma.task.create({
      data: { projectId, title: "p1", state: "backlog", executionPhase: 1, version: 1 },
    });

    await prisma.$transaction(async (tx) => {
      const { promotedTaskIds, assignedTaskIds } = await promoteEligibleAndAutoStartInTx(tx, projectId);
      expect(assignedTaskIds).toEqual([]);
      expect(promotedTaskIds.sort()).toEqual([a.id].sort());
    });

    const ra = await prisma.task.findUniqueOrThrow({ where: { id: a.id } });
    const rb = await prisma.task.findUniqueOrThrow({ where: { id: b.id } });
    expect(ra.state).toBe("todo");
    expect(rb.state).toBe("backlog");
  });

  it("promotes phase 1 after all phase 0 tasks are done", async () => {
    await prisma.task.deleteMany({ where: { projectId } });
    await prisma.task.create({
      data: { projectId, title: "p0 done", state: "done", executionPhase: 0, version: 1 },
    });
    const b = await prisma.task.create({
      data: { projectId, title: "p1 ready", state: "backlog", executionPhase: 1, version: 1 },
    });

    await prisma.$transaction(async (tx) => {
      const { promotedTaskIds, assignedTaskIds } = await promoteEligibleAndAutoStartInTx(tx, projectId);
      expect(assignedTaskIds).toEqual([]);
      expect(promotedTaskIds).toEqual([b.id]);
    });

    const rb = await prisma.task.findUniqueOrThrow({ where: { id: b.id } });
    expect(rb.state).toBe("todo");
  });

  it("pulls backlog prerequisites onto todo when a dependent is already todo", async () => {
    await prisma.task.deleteMany({ where: { projectId } });
    const pred = await prisma.task.create({
      data: {
        projectId,
        title: "prerequisite",
        state: "backlog",
        executionPhase: 0,
        version: 1,
      },
    });
    const succ = await prisma.task.create({
      data: {
        projectId,
        title: "dependent",
        state: "todo",
        executionPhase: 0,
        version: 1,
      },
    });
    await prisma.taskDependency.create({
      data: { successorTaskId: succ.id, predecessorTaskId: pred.id },
    });

    await prisma.$transaction(async (tx) => {
      const { promotedTaskIds } = await promoteEligibleAndAutoStartInTx(tx, projectId);
      expect(promotedTaskIds).toContain(pred.id);
    });

    const rp = await prisma.task.findUniqueOrThrow({ where: { id: pred.id } });
    expect(rp.state).toBe("todo");
  });

  it("promotes a chain of backlog prerequisites iteratively until the todo descendant is unblocked for waves", async () => {
    await prisma.task.deleteMany({ where: { projectId } });
    const grand = await prisma.task.create({
      data: {
        projectId,
        title: "grand prerequisite",
        state: "backlog",
        executionPhase: 0,
        version: 1,
      },
    });
    const parent = await prisma.task.create({
      data: {
        projectId,
        title: "parent prerequisite",
        state: "backlog",
        executionPhase: 0,
        version: 1,
      },
    });
    const leaf = await prisma.task.create({
      data: {
        projectId,
        title: "leaf dependent",
        state: "todo",
        executionPhase: 0,
        version: 1,
      },
    });
    await prisma.taskDependency.createMany({
      data: [
        { successorTaskId: leaf.id, predecessorTaskId: parent.id },
        { successorTaskId: parent.id, predecessorTaskId: grand.id },
      ],
    });

    await prisma.$transaction(async (tx) => {
      const { promotedTaskIds } = await promoteEligibleAndAutoStartInTx(tx, projectId);
      expect(new Set(promotedTaskIds)).toEqual(new Set([grand.id, parent.id]));
    });

    const rg = await prisma.task.findUniqueOrThrow({ where: { id: grand.id } });
    const rp = await prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    expect(rg.state).toBe("todo");
    expect(rp.state).toBe("todo");
  });

  it("does not bypass wave gates when pulling prerequisites for a todo task", async () => {
    await prisma.task.deleteMany({ where: { projectId } });
    const blocker = await prisma.task.create({
      data: {
        projectId,
        title: "blocking earlier wave",
        state: "backlog",
        executionPhase: 0,
        version: 1,
      },
    });
    const predHigh = await prisma.task.create({
      data: {
        projectId,
        title: "prerequisite wave 2",
        state: "backlog",
        executionPhase: 2,
        version: 1,
      },
    });
    const succ = await prisma.task.create({
      data: {
        projectId,
        title: "dependent wave 3",
        state: "todo",
        executionPhase: 3,
        version: 1,
      },
    });
    await prisma.taskDependency.create({
      data: { successorTaskId: succ.id, predecessorTaskId: predHigh.id },
    });

    await prisma.$transaction(async (tx) => {
      const { promotedTaskIds } = await promoteEligibleAndAutoStartInTx(tx, projectId);
      expect(promotedTaskIds).not.toContain(predHigh.id);
      expect(new Set(promotedTaskIds)).toEqual(new Set([blocker.id]));
    });

    const rph = await prisma.task.findUniqueOrThrow({ where: { id: predHigh.id } });
    expect(rph.state).toBe("backlog");
  });
});

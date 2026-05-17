import { prisma } from "./prisma.js";
import type { ProjectChatMessage } from "@prisma/client";

export type ProjectChatActorKind = "orchestrator" | "agent" | "system" | "user";

export async function appendProjectChatMessage(params: {
  projectId: string;
  actorKind: ProjectChatActorKind;
  actorId?: string | null;
  actorLabel: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<ProjectChatMessage | null> {
  const body = params.body.trim();
  if (!body) return null;
  return prisma.projectChatMessage.create({
    data: {
      projectId: params.projectId,
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      actorLabel: params.actorLabel.slice(0, 200),
      body: body.slice(0, 32_000),
      meta: (params.meta ?? {}) as object,
    },
  });
}

import { prisma } from "./prisma.js";
import type { SeatForTaskPrompt } from "../prompt/skills/composeSeatTaskPrompt.js";

export type LoadSeatOptions = {
  /** When set, load this team `role` row’s skill links (orchestration-matched seat). */
  preferredRoleId?: string | null;
};

async function fetchSeatForAgent(
  agentId: string,
  teamIds: string[],
  roleIdFilter?: string | null
): Promise<SeatForTaskPrompt | null> {
  const preferred = roleIdFilter?.trim();
  const roleWhere =
    preferred ?
      { id: preferred, teamId: { in: teamIds } }
    : { teamId: { in: teamIds } };

  const seat = await prisma.agentSeat.findFirst({
    where: { assignedAgentId: agentId, role: roleWhere },
    include: {
      role: {
        include: {
          skillLinks: {
            include: {
              skillTemplate: { select: { code: true, agentPrompt: true, sortOrder: true } },
            },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  if (!seat?.role) return null;
  return { skillLinks: seat.role.skillLinks };
}

/**
 * Loads a team seat for `agentId` on a team linked to `projectId`,
 * including skill links for composed LLM system prompts.
 * When `preferredRoleId` is set, uses that seat; otherwise the first seat (stable id order).
 */
export async function loadSeatForAgentOnProject(
  projectId: string,
  agentId: string | null | undefined,
  options?: LoadSeatOptions
): Promise<SeatForTaskPrompt | null> {
  const id = (typeof agentId === "string" ? agentId : "").trim();
  if (!id) {
    return null;
  }
  const teamLinks = await prisma.teamProject.findMany({
    where: { projectId },
    select: { teamId: true },
  });
  if (teamLinks.length === 0) return null;
  const teamIds = teamLinks.map((t) => t.teamId);
  const preferred = options?.preferredRoleId?.trim();

  if (preferred) {
    const hit = await fetchSeatForAgent(id, teamIds, preferred);
    if (hit) return hit;
  }
  return fetchSeatForAgent(id, teamIds, null);
}

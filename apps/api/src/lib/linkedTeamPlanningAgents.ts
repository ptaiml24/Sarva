import { prisma } from "./prisma.js";

/** One logical seat on a linked team (agent ↔ role row with skill links). */
export type PlanningSeat = {
  roleId: string;
  teamName: string;
  roleName: string;
  roleTemplateCode: string | null;
  roleTemplateLabel: string | null;
  skillCodes: string[];
  skillLabels: string[];
};

export type PlanningAgent = {
  id: string;
  name: string;
  /** Seats this agent occupies on linked teams (skills = active links on that role row). */
  seats: PlanningSeat[];
  /** One line per seat for LLM user messages. */
  capabilitySummary: string;
};

export function formatAgentCapabilityLines(seats: PlanningSeat[]): string {
  if (seats.length === 0) return "—";
  return seats
    .map((s) => {
      const tmpl =
        s.roleTemplateCode || s.roleTemplateLabel ?
          ` [role: ${[s.roleTemplateCode, s.roleTemplateLabel].filter(Boolean).join(" · ")}]`
        : "";
      const sk = s.skillLabels.length ? s.skillLabels.join(", ") : "—";
      return `${s.teamName} · ${s.roleName}${tmpl} — skills: ${sk} (targetRoleId=${s.roleId})`;
    })
    .join(" || ");
}

/**
 * Agents assigned to seats on teams linked to the project, with each seat’s role template and
 * **active skill templates** on that team role (capabilities drive orchestration).
 */
export async function loadAgentsOnLinkedTeamSeats(projectId: string): Promise<PlanningAgent[]> {
  const rows = await prisma.agentSeat.findMany({
    where: {
      assignedAgentId: { not: null },
      role: {
        team: {
          teamProjects: { some: { projectId } },
        },
      },
    },
    select: {
      assignedAgentId: true,
      assignedAgent: { select: { id: true, name: true } },
      role: {
        select: {
          id: true,
          name: true,
          roleTemplate: { select: { code: true, label: true } },
          team: { select: { name: true } },
          skillLinks: {
            select: {
              skillTemplate: { select: { code: true, label: true } },
            },
          },
        },
      },
    },
  });

  const byAgent = new Map<string, PlanningAgent>();

  for (const row of rows) {
    const ag = row.assignedAgent;
    const aid = row.assignedAgentId;
    if (!ag || !aid) continue;

    const tmpl = row.role.roleTemplate;
    const skillRows = row.role.skillLinks
      .map((l) => l.skillTemplate)
      .filter((x): x is { code: string; label: string } => Boolean(x?.code));
    const skillCodes = [...new Set(skillRows.map((x) => x.code))];
    const skillLabels = [...new Set(skillRows.map((x) => x.label))];

    const seat: PlanningSeat = {
      roleId: row.role.id,
      teamName: row.role.team.name,
      roleName: row.role.name,
      roleTemplateCode: tmpl?.code ?? null,
      roleTemplateLabel: tmpl?.label ?? null,
      skillCodes,
      skillLabels,
    };

    const existing = byAgent.get(aid);
    if (!existing) {
      byAgent.set(aid, { id: ag.id, name: ag.name, seats: [seat], capabilitySummary: "" });
    } else {
      existing.seats.push(seat);
    }
  }

  const list = [...byAgent.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const pa of list) {
    pa.capabilitySummary = formatAgentCapabilityLines(pa.seats);
  }
  return list;
}

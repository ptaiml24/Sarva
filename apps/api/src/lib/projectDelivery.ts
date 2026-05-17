import { prisma } from "./prisma.js";
import { getCompanyId } from "./tenant.js";

export const IMPLEMENTATION_STATUS = {
  DRAFT: "draft",
  DELIVERY_ACTIVE: "delivery_active",
  BACKLOG_PROPOSED: "backlog_proposed",
  BACKLOG_APPROVED: "backlog_approved",
  EXECUTING: "executing",
  READY_FOR_UAT: "ready_for_uat",
  CLOSED: "closed",
} as const;

export type ImplementationStatus = (typeof IMPLEMENTATION_STATUS)[keyof typeof IMPLEMENTATION_STATUS];

export type ReadinessResult = {
  ok: boolean;
  checks: {
    id: string;
    ok: boolean;
    detail: string;
  }[];
};

/**
 * True if the tenant can resolve an LLM for this project: company default, any binding on the PM agent,
 * project duty agents (SDM/TPM), team role bindings, or seated agents on teams linked to the project.
 */
async function projectHasResolvableLlmBinding(
  projectId: string,
  companyId: string | null,
  pmAgentId: string | null
): Promise<boolean> {
  if (!companyId) return false;

  const companyDefault = await prisma.modelBinding.findFirst({
    where: { companyId, agentId: null, roleId: null, skillId: null },
  });
  if (companyDefault) return true;

  const agentIds = new Set<string>();
  if (pmAgentId) agentIds.add(pmAgentId);

  const [teamLinks, roleAssignments] = await Promise.all([
    prisma.teamProject.findMany({ where: { projectId }, select: { teamId: true } }),
    prisma.projectRoleAssignment.findMany({ where: { projectId }, select: { agentId: true } }),
  ]);

  for (const ra of roleAssignments) {
    agentIds.add(ra.agentId);
  }

  const teamIds = [...new Set(teamLinks.map((t) => t.teamId))];
  let roleIds: string[] = [];
  if (teamIds.length > 0) {
    const roles = await prisma.role.findMany({
      where: { teamId: { in: teamIds } },
      select: { id: true },
    });
    roleIds = roles.map((r) => r.id);

    const seats = await prisma.agentSeat.findMany({
      where: { roleId: { in: roleIds }, assignedAgentId: { not: null } },
      select: { assignedAgentId: true },
    });
    for (const s of seats) {
      if (s.assignedAgentId) agentIds.add(s.assignedAgentId);
    }
  }

  const or: Array<{ agentId: { in: string[] } } | { roleId: { in: string[] } }> = [];
  const agentList = [...agentIds];
  if (agentList.length > 0) {
    or.push({ agentId: { in: agentList } });
  }
  if (roleIds.length > 0) {
    or.push({ roleId: { in: roleIds } });
  }
  if (or.length === 0) return false;

  const anyScoped = await prisma.modelBinding.findFirst({ where: { OR: or } });
  return Boolean(anyScoped);
}

export async function evaluateProjectReadiness(projectId: string): Promise<ReadinessResult> {
  const companyId = await getCompanyId();
  const [project, teamCount] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: { context: true },
    }),
    prisma.teamProject.count({ where: { projectId } }),
  ]);

  const checks: ReadinessResult["checks"] = [];

  checks.push({
    id: "project",
    ok: Boolean(project),
    detail: project ? "Project exists" : "Project not found",
  });

  const intakeOk = Boolean(
    project?.context?.brief?.trim() || project?.context?.goals?.trim()
  );
  checks.push({
    id: "intake",
    ok: intakeOk,
    detail: intakeOk ? "Brief or goals saved" : "Save brief or goals on Intake",
  });

  checks.push({
    id: "team",
    ok: teamCount >= 1,
    detail: teamCount >= 1 ? `${teamCount} team(s) linked` : "Link at least one team (Intake)",
  });

  const pmOk = Boolean(project?.pmOrchestratorAgentId);
  checks.push({
    id: "pm",
    ok: pmOk,
    detail: pmOk ? "PM orchestrator set" : "Choose PM orchestrator agent (Intake)",
  });

  const pmAgentId = project?.pmOrchestratorAgentId ?? null;
  const llmOk = await projectHasResolvableLlmBinding(projectId, companyId, pmAgentId);
  checks.push({
    id: "llm",
    ok: llmOk,
    detail: llmOk
      ? "Model binding present (company default, team seat/role, duty agents, or PM orchestrator)"
      : "Add a company-wide default or a model binding for a linked team role, seated agent, project duty agent, or PM orchestrator (Admin)",
  });

  return { ok: checks.every((c) => c.ok), checks };
}

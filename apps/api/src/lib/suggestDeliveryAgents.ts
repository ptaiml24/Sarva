import { prisma } from "./prisma.js";

export type DeliveryAgentHint = {
  duty: "pm_orchestrator" | "sdm_delivery" | "tpm_sprint";
  agentId: string;
  agentName: string;
  teamName: string;
  roleName: string;
  roleTemplateCode: string;
};

export type SuggestDeliveryAgentsResult = {
  pmOrchestratorAgentId: string | null;
  sdmDeliveryAgentId: string | null;
  tpmSprintAgentId: string | null;
  hints: DeliveryAgentHint[];
};

type DraftHint = Omit<DeliveryAgentHint, "agentName">;

/**
 * Picks PM / SDM / TPM orchestration agents from **linked teams**: first assigned seat per role-template code
 * (PM, SDM, TPM) when scanning teams A→Z and roles/seats in stable order.
 */
export async function suggestDeliveryAgentsFromLinkedTeams(projectId: string): Promise<SuggestDeliveryAgentsResult> {
  const links = await prisma.teamProject.findMany({
    where: { projectId },
    include: {
      team: {
        include: {
          roles: {
            include: {
              roleTemplate: { select: { code: true } },
              seats: { select: { id: true, assignedAgentId: true, label: true } },
            },
          },
        },
      },
    },
  });

  let pm: string | null = null;
  let sdm: string | null = null;
  let tpm: string | null = null;
  const drafts: DraftHint[] = [];

  const teamsSorted = [...links].sort((a, b) => a.team.name.localeCompare(b.team.name));

  for (const link of teamsSorted) {
    const roles = [...link.team.roles].sort((a, b) => a.name.localeCompare(b.name));
    for (const role of roles) {
      const code = role.roleTemplate?.code?.toUpperCase() ?? "";
      if (!["PM", "SDM", "TPM"].includes(code)) continue;

      const seats = [...role.seats].sort((a, b) => a.id.localeCompare(b.id));
      for (const seat of seats) {
        const aid = seat.assignedAgentId;
        if (!aid) continue;

        let duty: DeliveryAgentHint["duty"] | null = null;
        if (code === "PM" && !pm) duty = "pm_orchestrator";
        else if (code === "SDM" && !sdm) duty = "sdm_delivery";
        else if (code === "TPM" && !tpm) duty = "tpm_sprint";
        if (!duty) continue;

        drafts.push({
          duty,
          agentId: aid,
          teamName: link.team.name,
          roleName: role.name,
          roleTemplateCode: code,
        });

        if (duty === "pm_orchestrator") pm = aid;
        if (duty === "sdm_delivery") sdm = aid;
        if (duty === "tpm_sprint") tpm = aid;
        break;
      }
    }
  }

  const ids = [...new Set(drafts.map((d) => d.agentId))];
  const agents =
    ids.length === 0 ? [] : await prisma.agent.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const nameById = new Map(agents.map((a) => [a.id, a.name]));

  const hints: DeliveryAgentHint[] = drafts.map((d) => ({
    ...d,
    agentName: nameById.get(d.agentId) ?? d.agentId,
  }));

  return {
    pmOrchestratorAgentId: pm,
    sdmDeliveryAgentId: sdm,
    tpmSprintAgentId: tpm,
    hints,
  };
}

/** Page titles for the top bar — aligned with Delivery / Company / Admin IA in SARVA-REQUIREMENTS. */
export function pageTitleForPath(pathname: string): string {
  const projectTab = pathname.match(/^\/projects\/[^/]+\/([^/]+)$/);
  if (projectTab) {
    const tab = projectTab[1];
    const titles: Record<string, string> = {
      intake: "Project · Intake",
      requirements: "Project · Requirements",
      design: "Project · Design",
      backlog: "Project · Backlog",
      plan: "Project · Plan & backlog",
      board: "Project · Board",
      chat: "Project · Chat",
      "activity-log": "Project · Activity log",
      sprints: "Project · Sprints (legacy)",
      sdm: "Project · Backlog",
    };
    return titles[tab] ?? "Project";
  }
  if (/^\/projects\/[^/]+$/.test(pathname)) {
    return "Project";
  }
  const map: Record<string, string> = {
    "/dashboard": "Dashboard",
    "/chat": "Chat",
    "/organization/business-units": "Business units",
    "/organization/guided-setup": "Guided setup",
    "/organization/teams": "Teams",
    "/organization/skills-models": "Roles & skills",
    "/projects": "Projects",
    "/tasks": "Tasks",
    "/issues": "Issues",
    "/agents": "Agents",
    "/repos": "Repos & templates",
    "/governance/approvals": "Approvals",
    "/governance/email": "Email rules",
    "/system/costs": "Costs & budgets",
    "/system/audit": "Audit log",
    "/admin": "Admin",
    "/company": "Business units",
    "/workspace": "Teams",
  };
  return map[pathname] ?? "Sarva";
}

import { PrismaClient } from "@prisma/client";
import { shouldReplaceWithBuiltinDefault } from "../src/config/defaultSkillPrompts.js";

const prisma = new PrismaClient();

/**
 * Clear short/generic `agent_prompt` rows for Sarva built-in skill codes so the API merges prompts from
 * `src/prompt/skills/` (per-skill files), merged at runtime via `src/config/defaultSkillPrompts.ts`.
 */
async function syncBuiltinSkillPrompts() {
  const rows = await prisma.skillTemplate.findMany();
  for (const row of rows) {
    if (!shouldReplaceWithBuiltinDefault(row.code, row.agentPrompt)) continue;
    await prisma.skillTemplate.update({
      where: { id: row.id },
      data: { agentPrompt: null },
    });
  }
}

async function ensureDefaultCompany() {
  const existing = await prisma.company.findFirst();
  if (existing) {
    return existing;
  }
  const c = await prisma.company.create({
    data: { name: "Sarva", settings: {} },
  });
  console.log(JSON.stringify({ createdCompany: { id: c.id, name: c.name } }, null, 2));
  return c;
}

async function main() {
  await ensureDefaultCompany();
  await syncBuiltinSkillPrompts();
  console.log(
    JSON.stringify(
      {
        ok: true,
        hint: 'Single company row ensured if the database was empty (default name "Sarva"). No demo data inserted. Run npm run db:clean-sample to reset workspace (projects, teams, BUs, agents, etc.).',
      },
      null,
      2
    )
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

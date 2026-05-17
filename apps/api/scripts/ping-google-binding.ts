/**
 * Live Gemini check: reads your saved `LlmProviderConnection` (provider `google`) and calls generateContent.
 *
 * From `apps/api`:
 *   npx tsx scripts/ping-google-binding.ts [connection-uuid]
 *   npx tsx scripts/ping-google-binding.ts --list-models [connection-uuid]
 *
 * If the UUID is omitted, uses the first Google connection in the DB (by name order).
 */
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const prisma = new PrismaClient();

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL missing — set in apps/api/.env");
    process.exit(1);
  }

  const args = process.argv.slice(2).filter((a) => a !== "--");
  const listModels = args.includes("--list-models");
  const idArg = args.find((a) => a !== "--list-models" && !a.startsWith("--"))?.trim();

  const row = idArg
    ? await prisma.llmProviderConnection.findFirst({ where: { id: idArg, provider: "google" } })
    : await prisma.llmProviderConnection.findFirst({
        where: { provider: "google" },
        orderBy: { name: "asc" },
      });

  if (!row) {
    console.error(
      idArg
        ? `No LlmProviderConnection with id ${idArg} and provider google.`
        : "No google LlmProviderConnection in the database — create one in Admin (Google Gemini + API key)."
    );
    process.exit(1);
  }

  const key =
    row.apiKey?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_AI_API_KEY?.trim();
  if (!key) {
    console.error(
      "No API key: save one on the connection in Admin, or set GOOGLE_GENERATIVE_AI_API_KEY in apps/api/.env."
    );
    process.exit(1);
  }

  if (listModels) {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    const lr = await fetch(listUrl);
    const listRaw = await lr.text();
    if (!lr.ok) {
      console.error(`ListModels HTTP ${lr.status}`, listRaw.slice(0, 800));
      process.exit(1);
    }
    const list = JSON.parse(listRaw) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const gen = (list.models ?? []).filter((m) =>
      (m.supportedGenerationMethods ?? []).includes("generateContent")
    );
    console.log("Models supporting generateContent (use the id after `models/` — e.g. gemini-2.0-flash):");
    for (const m of gen.slice(0, 40)) {
      const id = m.name.replace(/^models\//, "");
      console.log(" ", id);
    }
    if (gen.length > 40) console.log(` … and ${gen.length - 40} more`);
    return;
  }

  const modelForPing = process.env.GEMINI_PING_MODEL_ID?.trim() || row.modelId;
  const mid = encodeURIComponent(modelForPing);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${mid}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: "Reply with a single short sentence confirming you received this Sarva connectivity test." }] },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 128 },
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error(`Gemini HTTP ${res.status}`);
    console.error(raw.slice(0, 1200));
    if (res.status === 404) {
      console.error(
        "\nTip: update Model id on this connection in Admin, or run:\n  npx tsx scripts/ping-google-binding.ts --list-models\n"
      );
    }
    process.exit(1);
  }
  const data = JSON.parse(raw) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

  console.log("Connection:", row.name, row.id);
  console.log("Model:", modelForPing, process.env.GEMINI_PING_MODEL_ID ? "(GEMINI_PING_MODEL_ID override)" : "");
  console.log("Reply:", reply.trim());
}

await main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

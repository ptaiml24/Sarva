import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests assume Postgres is migrated and API env is valid.
 *
 * If it looks like "nothing happens": Playwright is usually waiting for
 * `webServer` (up to 3 min) until http://127.0.0.1:5173 responds — or use
 * `PW_NO_WEBSERVER=1` when API + Vite are already running (see package.json `e2e:local`).
 */
const noWebServer = process.env.PW_NO_WEBSERVER === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(noWebServer
    ? {}
    : {
        webServer: {
          command: "npm run e2e:serve",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          /** Show API/Vite logs instead of a silent hang */
          stdout: "inherit",
          stderr: "inherit",
          env: {
            ...process.env,
            DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://sarva:sarva_dev@127.0.0.1:5432/sarva",
            JWT_SECRET: process.env.JWT_SECRET ?? "e2e-test-jwt-secret-32chars-min!!",
            PORT: "3000",
            /** Real LLM keys are not required in CI/local e2e; see apps/api `PM_PROPOSE_E2E_STUB`. */
            PM_PROPOSE_E2E_STUB: process.env.PM_PROPOSE_E2E_STUB ?? "true",
            PM_PLAN_BOARD_E2E_STUB: process.env.PM_PLAN_BOARD_E2E_STUB ?? "true",
          },
        },
      }),
});

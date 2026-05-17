import { expect, test } from "@playwright/test";

const adminEmail = `e2e-${Date.now()}@sarva.test`;

test.describe("Sarva operator journey", () => {
  /** Same HTTP client Playwright uses for navigation — waits for Vite if it starts slowly */
  test.beforeAll(async ({ request }) => {
    await expect(async () => {
      const res = await request.get("/login", { timeout: 10_000 });
      expect(res.ok(), `GET /login → ${res.status()}`).toBeTruthy();
    }).toPass({
      intervals: [500, 1000, 2000],
      timeout: 90_000,
    });
  });

  test("login → company → workspace → project → SDM → plan → board", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("login-page")).toBeVisible();

    await page.getByTestId("login-email").fill(adminEmail);
    await page.getByTestId("login-role").selectOption("admin");
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId("dashboard")).toBeVisible();

    await page.goto("/organization/business-units");
    await expect(page.getByTestId("business-units-page")).toBeVisible();
    /** Wait until `/api/v1/company` resolves — otherwise `company-card` is absent during Loading… and the test falsely enters “create company”. */
    await expect(page.getByText(/Business units group teams under your company/)).toBeVisible({ timeout: 30_000 });

    const companyCard = page.getByTestId("company-card");
    if ((await companyCard.count()) === 0) {
      await page.getByTestId("company-name-input").fill("E2E Company");
      await page.getByTestId("company-create").click();
      await expect(page.getByTestId("company-name")).toContainText("E2E Company");
    }

    await page.goto("/organization/teams");
    await expect(page.getByTestId("workspace-page")).toBeVisible();
    await expect(page.getByTestId("section-create-team")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("team-name").fill(`Team-${Date.now()}`);
    await page.getByTestId("team-add").click();
    await expect(page.getByTestId("team-workspace-focused")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("role-add")).toBeVisible();
    await page.getByTestId("role-add").click();

    await page.goto("/projects");
    await expect(page.getByTestId("projects-page")).toBeVisible();
    /** Workflow-backed projects render a different backlog UI without `sdm-advanced-propose`. */
    await page.getByTestId("project-workflow-kind").selectOption("legacy_none");
    const projectName = `Project-${Date.now()}`;
    await page.getByTestId("project-name-input").fill(projectName);
    await page.getByTestId("project-create").click();
    /** Create handler navigates straight to Intake (`ProjectsPage.create`), so the list row is not a stable assertion target. */
    await expect(page).toHaveURL(/\/projects\/[^/]+\/intake/, { timeout: 15_000 });
    await expect(page.getByTestId("project-title")).toContainText(projectName);

    await page.getByTestId("tab-intake").click();
    const persistIntakeGoalsBrief = page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        /\/api\/v1\/projects\/[^/]+\/context$/u.test(new URL(r.url()).pathname) &&
        r.status() >= 200 &&
        r.status() < 300,
      { timeout: 15_000 }
    );
    await page.getByTestId("project-brief").fill("Ship the vertical slice.");
    await persistIntakeGoalsBrief;

    await page.getByTestId("save-project-settings").click();
    await expect(page.getByTestId("overview-msg")).toContainText(/saved/i);

    const proceedBtn = page.getByTestId("delivery-proceed");
    await proceedBtn.scrollIntoViewIfNeeded();
    await expect(proceedBtn).toBeVisible();

    await page.getByTestId("tab-backlog").click();
    await expect(page.getByTestId("sdm-advanced-propose")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("sdm-advanced-propose").evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
    await page.getByTestId("pm-requirements").fill("Build login.\nBuild dashboard.");
    await page.getByTestId("pm-propose").click();
    await expect
      .poll(async () => page.locator('[data-testid^="accept-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.getByTestId("tab-plan").click();
    await expect(page.getByRole("button", { name: /Accept/ }).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /Accept/ }).first().click();

    await page.getByTestId("tab-board").click();
    await expect(page.getByTestId("project-board")).toBeVisible();
    await expect(page.locator('[data-testid^="task-card-"]').first()).toBeVisible({ timeout: 10_000 });
  });
});

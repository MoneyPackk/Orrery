import { expect, test } from "@playwright/test";

test("create, plan, run, deny, review, accept, and restore", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "New mission" }).click();
  await page.getByLabel("Mission title").fill("Harden command discovery");
  await page.getByLabel("Goal").fill("Find every command from the keyboard");
  await page.getByRole("button", { name: "Create mission", exact: true }).click();

  await page.getByLabel("Scope").fill("Add deterministic command search.");
  await page.getByRole("textbox", { name: "Action 1" }).fill("Index and rank commands");
  await page
    .getByRole("textbox", { name: "Acceptance criterion 1" })
    .fill("The delegated change is covered by passing tests");
  await page.getByRole("button", { name: "Save plan" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByRole("button", { name: "Start fixture run" })).toBeEnabled();
  await page.getByRole("button", { name: "Start fixture run" }).click();

  const permission = page.getByRole("region", { name: "Permission required" });
  await expect(permission).toContainText("registry.npmjs.org");
  await permission.getByRole("button", { name: "Deny" }).click();

  await expect(
    page.getByRole("region", { name: "Review studio" }).getByText(
      "Fixture implementation complete. One file changed and verification passed.",
    ),
  ).toBeVisible();
  const review = page.getByRole("region", { name: "Review studio" });
  await expect(review.getByText("src/mission-fixture.ts", { exact: true })).toBeVisible();
  await expect(review.getByText("8 fixture checks passed in 420ms")).toBeVisible();
  await page.getByRole("button", { name: "Accept mission" }).click();
  await expect(page.getByRole("button", { name: /Harden command discovery, accepted/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Harden command discovery" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Harden command discovery, accepted/ })).toBeVisible();
});

test("supports keyboard focus, reduced motion, mobile layout, and cancellation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await expect(page.locator(".app-shell")).toHaveCSS("min-width", "0px");

  const newMission = page.getByRole("button", { name: "New mission" });
  await newMission.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Mission title")).toBeFocused();
  await page.getByLabel("Mission title").fill("Cancel an isolated run");
  await page.getByLabel("Goal").fill("Verify interruption preserves durable state");
  await page.getByRole("button", { name: "Create mission", exact: true }).click();
  await page.getByLabel("Scope").fill("Exercise cancellation behavior.");
  await page.getByRole("textbox", { name: "Action 1" }).fill("Start fixture runtime");
  await page.getByRole("textbox", { name: "Acceptance criterion 1" }).fill("Cancellation is durable");
  await page.getByRole("button", { name: "Save plan" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByRole("button", { name: "Start fixture run" }).click();
  await expect(page.getByRole("region", { name: "Permission required" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel run" }).click();

  await expect(page.getByText("Run cancelled")).toBeVisible();
  await expect(page.getByRole("region", { name: "Permission required" })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: /Cancel an isolated run, cancelled/ })).toBeVisible();
});

test("reload during permission becomes an interrupted mission that can be cancelled", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "New mission" }).click();
  await page.getByLabel("Mission title").fill("Recover interrupted permission");
  await page.getByLabel("Goal").fill("Recover without stale runtime controls");
  await page.getByRole("button", { name: "Create mission", exact: true }).click();
  await page.getByLabel("Scope").fill("Exercise permission recovery.");
  await page.getByRole("textbox", { name: "Action 1" }).fill("Request guarded access");
  await page.getByRole("textbox", { name: "Acceptance criterion 1" }).fill("Interrupted work is safely cancellable");
  await page.getByRole("button", { name: "Save plan" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByRole("button", { name: "Start fixture run" }).click();
  await expect(page.getByRole("region", { name: "Permission required" })).toBeVisible();

  await page.reload();

  await expect(page.getByRole("button", { name: /Recover interrupted permission, blocked/ })).toBeVisible();
  await expect(page.getByText(/interrupted by an application reload/i)).toBeVisible();
  await expect(page.getByRole("region", { name: "Permission required" })).toBeHidden();
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByRole("button", { name: /Recover interrupted permission, cancelled/ })).toBeVisible();
});

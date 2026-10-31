import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./support";

/** Fails on serious or critical axe violations, listing each rule and where it hit. */
async function expectAccessible(page: Page, what: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
    `${what} has accessibility violations`,
  ).toEqual([]);
}

test("login page", async ({ page }) => {
  await page.goto("/login");
  await expectAccessible(page, "login");
});

test("main pages, signed in as an admin", async ({ page }) => {
  await login(page, "alice");
  for (const path of ["/", "/orgs/org_1/transactions", "/orgs/org_1/payouts", "/orgs/org_1/reports", "/orgs/org_1/audit", "/orgs/org_1/settings/webhooks"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {}); // the SSE stream never idles
    await expect(page.getByRole("main").or(page.locator("main")).first()).toBeVisible();
    await page.waitForTimeout(500);
    await expectAccessible(page, path);
  }
});

test("pay-out dialogs and the detail panel", async ({ page }) => {
  await login(page, "bob");
  await page.goto("/orgs/org_1/payouts");
  await page.getByRole("button", { name: "New pay-out" }).click();
  await expect(page.getByRole("dialog", { name: "New pay-out" })).toBeVisible();
  await expectAccessible(page, "new pay-out dialog");
  // Errors shown in the form.
  await page.getByRole("dialog", { name: "New pay-out" }).getByRole("button", { name: "Review" }).click();
  await expectAccessible(page, "new pay-out dialog with errors");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /PT Kopi Nusantara/ }).click();
  await expect(page.getByRole("complementary", { name: "Pay-out details" })).toBeVisible();
  await expectAccessible(page, "pay-out detail panel");
});

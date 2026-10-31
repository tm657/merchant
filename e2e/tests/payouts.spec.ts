import { expect, test } from "@playwright/test";
import { login, userPage } from "./support";

test("bob creates a pay-out, alice approves it, and bob sees it paid live over SSE", async ({ page, browser }) => {
  await login(page, "bob");
  await page.goto("/orgs/org_1/payouts");
  await page.getByRole("button", { name: "New pay-out" }).click();

  const dialog = page.getByRole("dialog", { name: "New pay-out" });
  await dialog.getByLabel("Amount").fill("12.34");
  await dialog.getByLabel("Beneficiary name").fill("E2E Supplies");
  await dialog.getByLabel("Account number").fill("GB99 8877 6655");
  await dialog.getByRole("button", { name: "Review" }).click();
  await expect(dialog.getByText("$12.34")).toBeVisible();
  await dialog.getByRole("button", { name: "Create pay-out" }).click();

  // The new pay-out opens in the panel, waiting for someone else.
  await expect(page).toHaveURL(/payout=po_/);
  const payoutId = new URL(page.url()).searchParams.get("payout")!;
  const panel = page.getByRole("complementary", { name: "Pay-out details" });
  await expect(panel.getByText("Pending approval", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Approve" })).toHaveCount(0); // never on your own

  // Alice, in her own browser session, approves it.
  const alice = await userPage(browser, "alice");
  await alice.goto(`/orgs/org_1/payouts?payout=${payoutId}`);
  const alicePanel = alice.getByRole("complementary", { name: "Pay-out details" });
  await alicePanel.getByRole("button", { name: "Approve" }).click();
  await alice.getByRole("dialog", { name: "Approve pay-out?" }).getByRole("button", { name: "Approve" }).click();
  await expect(alicePanel.getByText(/Approved|Processing|Paid/).first()).toBeVisible();

  // Bob never reloads: the worker pays it and the event arrives over SSE.
  await expect(panel.locator("span", { hasText: /^Paid$/ })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("listitem").filter({ hasText: "Alice Admin" })).toBeVisible();
  await expect(panel.getByRole("listitem").filter({ hasText: /Paid · System/ })).toBeVisible();
  await alice.context().close();
});

import { expect, test } from "@playwright/test";
import { login } from "./support";

test("a member of another org gets No access, and the API answers 403", async ({ page }) => {
  // Dave belongs to org_3 only.
  await login(page, "dave");
  await page.goto("/orgs/org_1/transactions");
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  for (const path of ["transactions", "balances", "payouts"]) {
    const res = await page.request.get(`/api/orgs/org_1/${path}`);
    expect(res.status(), path).toBe(403);
  }
  // Their own org works.
  expect((await page.request.get("/api/orgs/org_3/transactions")).status()).toBe(200);
});

test("role limits hide what the API refuses: support sees no reports or audit", async ({ page }) => {
  await login(page, "carol");
  await page.goto("/orgs/org_2/transactions");
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByRole("link", { name: "Transactions" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Reports" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Audit log" })).toHaveCount(0);
  await page.goto("/orgs/org_2/reports");
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  expect((await page.request.get("/api/orgs/org_2/exports")).status()).toBe(403);
});

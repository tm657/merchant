import { expect, login, test } from "./support";

test("logs in, lands on the org list, and logs out", async ({ page }) => {
  await login(page, "alice");
  await expect(page.getByRole("link", { name: /Acme Retail/ })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  // The session is gone: protected pages send you back to the login page.
  await page.goto("/orgs/org_1/transactions");
  await expect(page).toHaveURL(/\/login\?next=%2Forgs%2Forg_1%2Ftransactions/);
});

test("rejects a wrong password without saying which part was wrong", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // (Next.js also renders an empty route-announcer alert, so match ours by its text.)
  await expect(page.getByRole("alert").filter({ hasText: /email or password/i })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

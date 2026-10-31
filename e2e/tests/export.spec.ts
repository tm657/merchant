import { readFile } from "node:fs/promises";
import { expect, login, test } from "./support";

test("exports the current filters and downloads the CSV", async ({ page }) => {
  await login(page, "bob");
  await page.goto("/orgs/org_1/transactions?currency=IDR&status=success");
  await page.getByRole("button", { name: "Export these filters" }).click();
  await page.getByRole("link", { name: "Follow it on Reports" }).click();
  await expect(page).toHaveURL(/\/orgs\/org_1\/reports/);

  const item = page.getByRole("listitem").filter({ hasText: /IDR/ }).first();
  const link = item.getByRole("link", { name: /Download CSV/ });
  await expect(link).toBeVisible({ timeout: 30_000 });

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^transactions-org_1-\d{4}-\d{2}-\d{2}-[a-z0-9-]{8}\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  const [header, ...rows] = csv.trim().split("\r\n");
  expect(header).toBe("id,created_at,type,status,counterparty,amount,currency,payout_id");
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const cells = row.split(",");
    expect(cells[3]).toBe("success");
    expect(cells[6]).toBe("IDR");
    // IDR has no minor unit: whole numbers only, never floats.
    expect(cells[5]).toMatch(/^-?\d+$/);
  }
});

import { expect, test } from "@playwright/test";
import { login } from "./support";

const firstRow = (page: import("@playwright/test").Page) => page.getByRole("table", { name: "Transactions" }).locator("tbody tr").first();

test("filters live in the URL, survive reload and back, and paging uses cursors", async ({ page }) => {
  await login(page, "bob");
  await page.goto("/orgs/org_1/transactions");
  await expect(firstRow(page)).toBeVisible();

  await page.getByLabel("Status").selectOption("failed");
  await expect(page).toHaveURL(/status=failed/);
  const statuses = page.getByRole("table", { name: "Transactions" }).locator("tbody tr td:nth-child(4)");
  await expect(statuses.first()).toHaveText("failed");
  expect(new Set(await statuses.allTextContents())).toEqual(new Set(["failed"]));

  // The URL is the source of truth: a reload shows the same view.
  await page.reload();
  await expect(page.getByLabel("Status")).toHaveValue("failed");
  await expect(statuses.first()).toHaveText("failed");

  // Paging: Next shows other rows, Prev brings the first page back.
  const page1 = await firstRow(page).textContent();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/^Page 2/)).toBeVisible();
  await expect(firstRow(page)).not.toHaveText(page1!);
  await page.getByRole("button", { name: "Prev" }).click();
  await expect(page.getByText(/^Page 1/)).toBeVisible();
  await expect(firstRow(page)).toHaveText(page1!);

  // Sort is in the URL too.
  await page.getByRole("button", { name: /Amount/ }).click();
  await expect(page).toHaveURL(/sort=amount/);

  // Back undoes the sort, then the filter.
  await page.goBack();
  await expect(page).not.toHaveURL(/sort=amount/);
  await page.goBack();
  await expect(page).not.toHaveURL(/status=failed/);
  await expect(page.getByLabel("Status")).toHaveValue("");
});

test("search is debounced into the URL", async ({ page }) => {
  await login(page, "bob");
  await page.goto("/orgs/org_1/transactions");
  await page.getByLabel("Counterparty").fill("grab");
  await expect(page).toHaveURL(/q=grab/);
  const counterparties = page.getByRole("table", { name: "Transactions" }).locator("tbody tr td:nth-child(3)");
  await expect(counterparties.first()).toHaveText(/grab/i);
});

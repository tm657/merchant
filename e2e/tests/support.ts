import { test as base, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PASSWORDS_FILE, WEB_URL } from "../stack";

/**
 * Collects Content-Security-Policy violations on a page: both the browser's console
 * report and the securitypolicyviolation event (which also catches blocked styles).
 */
function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  void page.exposeFunction("__reportCspViolation", (v: string) => violations.push(v)).catch(() => {});
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __reportCspViolation?: (v: string) => void }).__reportCspViolation?.(
        `${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`,
      );
    });
  });
  return violations;
}

// Pages opened in extra browser contexts (userPage) are watched too, and checked at the end.
const extraWatches: { user: string; violations: string[] }[] = [];

/**
 * Every spec uses this `test`: any CSP violation on any page fails the test. Nothing
 * else about the tests changes.
 */
export const test = base.extend<{ cspGuard: void }>({
  page: async ({ page }, use) => {
    const violations = watchCsp(page);
    await use(page);
    expect(violations, "Content-Security-Policy violations").toEqual([]);
  },
  cspGuard: [
    // Playwright requires a destructuring pattern here, even an empty one.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      extraWatches.length = 0;
      await use();
      for (const w of extraWatches) expect(w.violations, `CSP violations (${w.user}'s browser)`).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export type User = "alice" | "bob" | "carol" | "dave";
export const NAMES: Record<User, string> = { alice: "Alice Admin", bob: "Bob Both", carol: "Carol Support", dave: "Dave Finance" };

export function password(user: User): string {
  const all = JSON.parse(readFileSync(PASSWORDS_FILE, "utf8")) as Record<string, string>;
  const pw = all[`${user}@example.com`];
  if (!pw) throw new Error(`no seed password for ${user}`);
  return pw;
}

/** Signs in through the real form. */
export async function login(page: Page, user: User) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`${user}@example.com`);
  await page.getByLabel("Password").fill(password(user));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${NAMES[user]}` })).toBeVisible();
}

/** A separate browser context (its own cookies), signed in as `user`. */
export async function userPage(browser: Browser, user: User): Promise<Page> {
  const context = await browser.newContext({ baseURL: WEB_URL });
  const page = await context.newPage();
  extraWatches.push({ user, violations: watchCsp(page) });
  await login(page, user);
  return page;
}

/** State-changing BFF calls need the app's Origin (the CSRF check), like the browser sends. */
export const sameOrigin = { origin: WEB_URL };

export async function createPayout(request: APIRequestContext, amount: number, beneficiaryName: string) {
  const res = await request.post("/api/orgs/org_1/payouts", {
    headers: { ...sameOrigin, "idempotency-key": `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    data: { amount, currency: "USD", beneficiaryName, accountNumber: "GB1234567890" },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { payout: { id: string; version: number } }).payout;
}

export async function approve(request: APIRequestContext, id: string, version = 1) {
  const res = await request.post(`/api/orgs/org_1/payouts/${id}/approve`, { headers: sameOrigin, data: { version } });
  expect(res.status()).toBe(200);
}

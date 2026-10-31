import { WEB_MODE } from "../stack";
import { expect, login, password, sameOrigin, test } from "./support";

// Runs against the production build by default, and against `next dev` with E2E_WEB=dev
// (npm run test:e2e:dev). Tagged @csp so the dev run can pick just these.
const dev = WEB_MODE === "dev";

const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];

test.describe("security headers and CSP @csp", () => {
  test("pages get a nonce CSP and the security headers", async ({ page }) => {
    const res = await page.goto("/login");
    const h = res!.headers();
    const csp = h["content-security-policy"]!;
    const nonce = nonceOf(csp);
    expect(nonce, csp).toBeTruthy();
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    if (!dev) expect(csp).not.toContain("unsafe"); // no unsafe-inline or unsafe-eval in production
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["x-powered-by"]).toBeUndefined();
    if (dev) expect(h["strict-transport-security"]).toBeUndefined();
    else expect(h["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");

    // Every script the server sent carries this request's nonce. (Scripts that trusted
    // scripts add later, like dev tooling, need none: that's what 'strict-dynamic' allows.
    // Anything actually blocked is caught by the page fixture's violation check.)
    const html = await res!.text();
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((tag) => !tag.includes(`nonce="${nonce}"`))).toEqual([]);

    // A new request, a new nonce.
    const again = await page.request.get("/login");
    expect(nonceOf(again.headers()["content-security-policy"]!)).not.toBe(nonce);
  });

  test("main pages render and stay interactive with no CSP violations", async ({ page }) => {
    // The page fixture fails the test on any violation; here we just walk the app.
    await login(page, "alice");
    for (const path of ["/orgs/org_1/transactions", "/orgs/org_1/payouts", "/orgs/org_1/reports", "/orgs/org_1/audit", "/orgs/org_1/settings/webhooks"]) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
    }
    // Client-side behaviour works (scripts ran): open and close a dialog.
    await page.goto("/orgs/org_1/payouts");
    await page.getByRole("button", { name: "New pay-out" }).click();
    await expect(page.getByRole("dialog", { name: "New pay-out" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "New pay-out" })).toBeHidden();
  });

  test(`the session cookie is ${dev ? "plain in development" : "__Host- prefixed and Secure"}`, async ({ page }) => {
    await login(page, "alice");
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name.endsWith("mp_session"))!;
    expect(session.name).toBe(dev ? "mp_session" : "__Host-mp_session");
    expect(session.httpOnly).toBe(true);
    expect(session.path).toBe("/");
    expect(session.sameSite).toBe("Lax");
    if (!dev) expect(session.secure).toBe(true);
    // Logging out really clears it (a __Host- cookie can only be cleared with matching attributes).
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/);
    expect((await page.context().cookies()).some((c) => c.name.endsWith("mp_session"))).toBe(false);
  });

  test("BFF routes: JSON-only CSP, 16 KB body cap, and no CORS", async ({ page }) => {
    const res = await page.request.post("/api/auth/login", {
      headers: sameOrigin,
      data: { email: "alice@example.com", password: password("alice") },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");

    const big = await page.request.post("/api/auth/login", {
      headers: sameOrigin,
      data: { email: "alice@example.com", password: "x".repeat(20_000) },
    });
    expect(big.status()).toBe(413);
    expect(await big.json()).toMatchObject({ error: "payload_too_large" });

    const foreign = await page.request.get("/api/orgs/org_1/transactions", { headers: { origin: "https://evil.example" } });
    expect(Object.keys(foreign.headers()).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    const preflight = await page.request.fetch("/api/auth/login", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(Object.keys(preflight.headers()).filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });
});

import { defineConfig, devices } from "@playwright/test";
import { API_URL, apiEnv, WEB_URL } from "./stack";

// npm run test:e2e first builds the web app and prepares the e2e database
// (api/scripts/e2e-prepare.ts); Playwright then starts every process below.
const env = { ...process.env, ...apiEnv() } as Record<string, string>;

// Quiet by default: the servers' logs stay out of the test output. E2E_VERBOSE=1 prints
// them again (prefixed with the server's name). Readiness doesn't depend on this:
// Playwright reads the workers' "started" line from stdout either way.
const verbose = process.env.E2E_VERBOSE === "1";
const output = verbose ? ({ stdout: "pipe", stderr: "pipe" } as const) : ({ stdout: "ignore", stderr: "ignore" } as const);
const worker = (name: string, script: string, ready: RegExp) => ({
  name,
  command: `npm run ${script} -w api`,
  cwd: "..",
  // Info level: the "started" line is what Playwright waits for.
  env: { ...env, LOG_LEVEL: "info" },
  wait: { stdout: ready },
  ...output,
  timeout: 60_000,
});

export default defineConfig({
  testDir: "./tests",
  // One shared database: tests run one at a time, in a known order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Locally: one line per test. CI: annotations plus the HTML report (uploaded as an artifact).
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["line"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "api",
      command: "npm run start -w api",
      cwd: "..",
      env,
      url: `${API_URL}/readyz`,
      ...output,
      timeout: 60_000,
    },
    worker("payout worker", "worker", /pay-out worker started/),
    worker("webhook worker", "webhooks", /webhook worker started/),
    worker("reports worker", "reports", /reports worker started/),
    {
      name: "web",
      // The production build (npm run build -w web), as users get it.
      command: `npm run start -w web -- -p ${new URL(WEB_URL).port}`,
      cwd: "..",
      env: { ...process.env, API_URL } as Record<string, string>,
      url: `${WEB_URL}/login`,
      ...output,
      timeout: 60_000,
    },
  ],
});

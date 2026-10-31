// The e2e stack: its own database, Redis db and ports (stack.json), never the dev ones.
// Values come from api/.env locally, or the environment in CI.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
const apiEnvFile = join(ROOT, "api", ".env");
if (existsSync(apiEnvFile)) process.loadEnvFile(apiEnvFile); // shell/CI values win

export const stack = JSON.parse(readFileSync(join(here, "stack.json"), "utf8")) as {
  database: string;
  appRole: string;
  appPassword: string;
  redisDb: number;
  apiPort: number;
  webPort: number;
  receiverPort: number;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`e2e needs ${name} (set it in api/.env or the environment)`);
  return v;
}
const withPath = (url: string, path: string, user?: [string, string]) => {
  const u = new URL(url);
  u.pathname = path;
  if (user) [u.username, u.password] = user;
  return u.toString();
};

export const WEB_URL = `http://localhost:${stack.webPort}`;
export const API_URL = `http://127.0.0.1:${stack.apiPort}`;
export const RECEIVER_URL = `http://127.0.0.1:${stack.receiverPort}/webhooks`;
export const EXPORT_DIR = join(here, ".cache", "exports");
export const PASSWORDS_FILE = join(here, ".cache", "seed-users.local.json");

/** Environment for the API and its three workers. Deterministic where tests need it. */
export function apiEnv(): Record<string, string> {
  const owner = withPath(required("MIGRATION_DATABASE_URL"), `/${stack.database}`);
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
    HOST: "127.0.0.1",
    PORT: String(stack.apiPort),
    MIGRATION_DATABASE_URL: owner,
    DATABASE_URL: withPath(owner, `/${stack.database}`, [stack.appRole, stack.appPassword]),
    REDIS_URL: withPath(required("REDIS_URL"), `/${stack.redisDb}`),
    // No random transactions: pages and counts stay put while tests run.
    SIMULATOR: "off",
    // A fixed throwaway key: e2e data is recreated every run.
    WEBHOOK_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
    WEBHOOK_ALLOW_PRIVATE_TARGETS: "true",
    EXPORT_DIR,
    // The simulated provider always pays, quickly.
    PROVIDER_DECLINE_RATE: "0",
    PROVIDER_TRANSIENT_RATE: "0",
    PROVIDER_MIN_LATENCY_MS: "50",
    PROVIDER_MAX_LATENCY_MS: "200",
    WORKER_POLL_MS: "200",
    OUTBOX_POLL_MS: "100",
    WEBHOOK_POLL_MS: "200",
    EXPORT_POLL_MS: "200",
  };
}

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const flag = z.enum(["on", "off"]);

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Fastify's trustProxy: who may set X-Forwarded-For. Default: only the BFF on this machine.
  TRUST_PROXY: z.string().min(1).default("loopback"),

  // The application's login role: not a superuser and not the owner of any table.
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  SIMULATOR: flag.default("on"),
  MAX_STREAMS_PER_ORG: z.coerce.number().int().min(1).default(20),

  // 32 random bytes, base64 (openssl rand -base64 32). Encrypts webhook signing secrets.
  WEBHOOK_SECRET_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64 encoded (openssl rand -base64 32)"),
  // Lets webhooks reach loopback and private addresses, for a local receiver. Never in production.
  WEBHOOK_ALLOW_PRIVATE_TARGETS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const noPrivateTargetsInProduction = <T extends { NODE_ENV: string; WEBHOOK_ALLOW_PRIVATE_TARGETS: boolean }>(c: T) =>
  c.NODE_ENV !== "production" || !c.WEBHOOK_ALLOW_PRIVATE_TARGETS;
const privateTargetsError = { message: "must be false in production", path: ["WEBHOOK_ALLOW_PRIVATE_TARGETS"] };

/** The API server. */
export const apiConfigSchema = configSchema.refine(noPrivateTargetsInProduction, privateTargetsError);

/** db:migrate and db:seed: the owner of the schema, plus the app role to create. */
export const migrationConfigSchema = configSchema.pick({ DATABASE_URL: true }).extend({
  MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type Config = z.infer<typeof configSchema>;

const rate = z.coerce.number().min(0).max(1);

/** The pay-out worker process (npm run worker). */
export const workerConfigSchema = configSchema
  .pick({ NODE_ENV: true, LOG_LEVEL: true, DATABASE_URL: true, REDIS_URL: true })
  .extend({
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
    WORKER_POLL_MS: z.coerce.number().int().min(50).default(1000),
    OUTBOX_POLL_MS: z.coerce.number().int().min(50).default(250),
    PAYOUT_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
    PAYOUT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    // The simulated provider: about 10% of attempts fail, half of those retryably.
    PROVIDER_DECLINE_RATE: rate.default(0.05),
    PROVIDER_TRANSIENT_RATE: rate.default(0.05),
    PROVIDER_MIN_LATENCY_MS: z.coerce.number().int().min(0).default(200),
    PROVIDER_MAX_LATENCY_MS: z.coerce.number().int().min(0).default(1500),
  })
  .refine((c) => c.PROVIDER_MIN_LATENCY_MS <= c.PROVIDER_MAX_LATENCY_MS, {
    message: "must be <= PROVIDER_MAX_LATENCY_MS",
    path: ["PROVIDER_MIN_LATENCY_MS"],
  })
  .refine((c) => c.PROVIDER_DECLINE_RATE + c.PROVIDER_TRANSIENT_RATE <= 1, {
    message: "decline and transient rates must add up to at most 1",
    path: ["PROVIDER_TRANSIENT_RATE"],
  })
  // A provider call must end before the claim on its row can expire.
  .refine((c) => c.PROVIDER_MAX_LATENCY_MS < c.PAYOUT_LEASE_MS / 2, {
    message: "must be under half of PAYOUT_LEASE_MS",
    path: ["PROVIDER_MAX_LATENCY_MS"],
  });
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

/** Loads api/.env if present. Variables already set in the environment win. */
function loadEnvFile() {
  const path = join(API_ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * Parses the environment against `schema`. On any problem it prints every bad variable
 * and exits, so a misconfigured process never starts.
 */
export function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  if (env === process.env) loadEnvFile();
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
  console.error(`Invalid configuration (see api/.env.example):\n${lines.join("\n")}`);
  process.exit(1);
}

/** The full API config. Call once at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parseEnv(apiConfigSchema, env);
}

/** The webhook delivery worker (npm run webhooks). */
export const webhookWorkerConfigSchema = configSchema
  .pick({ NODE_ENV: true, LOG_LEVEL: true, DATABASE_URL: true, WEBHOOK_SECRET_KEY: true, WEBHOOK_ALLOW_PRIVATE_TARGETS: true })
  .extend({
    WEBHOOK_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    WEBHOOK_POLL_MS: z.coerce.number().int().min(50).default(1000),
    WEBHOOK_LEASE_MS: z.coerce.number().int().min(10_000).default(30_000),
    WEBHOOK_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(5000),
  })
  .refine(noPrivateTargetsInProduction, privateTargetsError);
export type WebhookWorkerConfig = z.infer<typeof webhookWorkerConfigSchema>;

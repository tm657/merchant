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

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // App data still lives in SQLite until the Postgres data migration lands.
  DB_PATH: z.string().min(1).default(join(API_ROOT, "data", "payments.db")),

  SIMULATOR: flag.default("on"),
  MAX_STREAMS_PER_ORG: z.coerce.number().int().min(1).default(20),
});

export type Config = z.infer<typeof configSchema>;

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
  console.error(`Invalid API configuration (see api/.env.example):\n${lines.join("\n")}`);
  process.exit(1);
}

/** The full API config. Call once at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parseEnv(configSchema, env);
}

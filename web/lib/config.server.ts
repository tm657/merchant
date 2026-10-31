import "server-only";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Where the BFF reaches the API. Server-only: never sent to the browser.
  API_URL: z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, "")),
  // This app's public origin, for the CSRF check. Set it behind a proxy that rewrites Host.
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
});

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

/**
 * The validated server config. instrumentation.ts calls this at startup, so a bad or
 * missing variable stops the server before it handles any request.
 */
export function getConfig(): Config {
  if (cached) return cached;
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid web configuration (see web/.env.example):\n${lines.join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

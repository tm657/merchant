import { getConfig } from "./lib/config.server";

// Fail fast: a missing or invalid variable stops the server before it serves anything.
try {
  getConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // Real Postgres and Redis, real argon2: give each test room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Files run in parallel; every test has its own schema and Redis prefix.
    pool: "forks",
  },
});

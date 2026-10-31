import type { ExportJob } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, onTestFinished } from "vitest";
import { createDb } from "./db.js";
import { createExportWorker } from "./exports/worker.js";
import { handleShutdown } from "./shutdown.js";
import { TEST_APP_URL, TEST_DATABASE_URL, TEST_REDIS_URL } from "./test/env.js";
import { makeTestApp, TEST_EXPORT_DIR } from "./test/helpers.js";

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = { info() {}, warn() {}, error() {} } as never;

describe("handleShutdown", () => {
  function setup(stop: () => Promise<void>, graceMs = 1000) {
    const exits: number[] = [];
    const dispose = handleShutdown({ log, graceMs, stop, exit: (code) => exits.push(code) });
    onTestFinished(dispose);
    return exits;
  }
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("runs stop once and exits 0 when it finishes", async () => {
    let calls = 0;
    const exits = setup(async () => {
      calls++;
    });
    process.emit("SIGTERM");
    await until(() => exits.length > 0);
    assert.deepEqual(exits, [0]);
    assert.equal(calls, 1);
  });

  it("exits 1 when stop outlasts the grace period", async () => {
    const exits = setup(() => new Promise(() => {}), 50);
    process.emit("SIGTERM");
    await until(() => exits.length > 0);
    assert.deepEqual(exits, [1]);
  });

  it("a second signal exits 1 at once, without waiting", async () => {
    const exits = setup(() => new Promise(() => {}), 60_000);
    process.emit("SIGTERM");
    process.emit("SIGINT");
    assert.deepEqual(exits, [1]);
  });
});

describe("exports on shutdown", () => {
  it("an export interrupted between pages goes back to the queue, and another worker finishes it", async () => {
    const t = await makeTestApp();
    for (let i = 0; i < 6; i++) {
      await t.db.query(
        `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
         VALUES ($1, 'org_1', 'Shop', 100, 'USD', 'success', now())`,
        [`txn_sd_${i}`],
      );
    }
    const job = (
      (await t.app.inject({ method: "POST", url: "/orgs/org_1/exports", headers: { authorization: `Bearer ${await t.tokenFor("admin@test.com")}` }, payload: {} })).json() as {
        export: ExportJob;
      }
    ).export;

    const make = () =>
      createExportWorker({ db: t.db, redis: t.redis, prefix: t.redisPrefix, exportDir: TEST_EXPORT_DIR, log, clock: t.clock.now, pageSize: 2 });
    const stopping = make();
    const [claim] = await stopping.claim(1);
    const filesBefore = existsSync(TEST_EXPORT_DIR) ? readdirSync(TEST_EXPORT_DIR).length : 0;
    const abort = new AbortController();
    abort.abort(); // shutdown arrives before the first page
    assert.equal(await stopping.run(claim!, abort.signal), "queued");

    const { rows } = await t.db.query<{ status: string; attempts: number; rows_written: number }>(
      "SELECT status, attempts, rows_written FROM export_jobs WHERE id = $1",
      [job.id],
    );
    assert.deepEqual(rows[0], { status: "queued", attempts: 0, rows_written: 0 }, "attempt not counted");
    assert.equal(await stopping.slots.running("org_1"), 0, "slot released at once, not at lease expiry");
    assert.equal(existsSync(TEST_EXPORT_DIR) ? readdirSync(TEST_EXPORT_DIR).length : 0, filesBefore, "partial file removed");
    const events = await t.db.query<{ payload: { status: string } }>("SELECT payload FROM outbox WHERE type = 'export'");
    assert.ok(events.rows.some((r) => r.payload.status === "queued"), "the Reports page hears it's queued again");

    assert.equal(await make().runOnce(2), 1, "picked up straight away");
    const done = await t.db.query<{ status: string; rows_written: number }>("SELECT status, rows_written FROM export_jobs WHERE id = $1", [job.id]);
    assert.deepEqual(done.rows[0], { status: "completed", rows_written: 6 });
  });
});

// ---- Real processes ------------------------------------------------------------------

type Proc = { child: ChildProcess; output: () => string; exited: Promise<number | null> };

function start(entry: string, env: Record<string, string>): Proc {
  // node --import tsx: one process, so the signal reaches it (not an npm wrapper).
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: TEST_APP_URL,
      REDIS_URL: TEST_REDIS_URL,
      WEBHOOK_SECRET_KEY: Buffer.alloc(32, 9).toString("base64"),
      EXPORT_DIR: join(tmpdir(), "mini-payments-shutdown-exports"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  onTestFinished(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return { child, output: () => out, exited };
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const port = () => 41_000 + Math.floor(Math.random() * 2000);

describe("graceful shutdown of the real processes", () => {
  it("API: /readyz turns 503 draining, then the server closes and exits 0", async () => {
    const p = port();
    const api = start("src/server.ts", { PORT: String(p), HOST: "127.0.0.1", SIMULATOR: "off", SHUTDOWN_DRAIN_MS: "1500" });
    const ready = `http://127.0.0.1:${p}/readyz`;
    await waitFor(async () => ((await fetch(ready).then((r) => r.status).catch(() => 0)) === 200 ? true : undefined), "the API to be ready");

    api.child.kill("SIGTERM");
    const draining = await waitFor(async () => {
      const r = await fetch(ready).catch(() => null);
      return r?.status === 503 ? ((await r.json()) as { status: string }) : undefined;
    }, "readyz to report draining", 3000);
    assert.deepEqual(draining, { status: "draining", checks: {} });

    assert.equal(await api.exited, 0, api.output());
    assert.match(api.output(), /shutting down: finishing in-flight work/);
    assert.match(api.output(), /shutdown complete/);
    await assert.rejects(fetch(ready), "no longer listening");
  });

  it("API: a second signal exits 1 straight away", async () => {
    const p = port();
    const api = start("src/server.ts", { PORT: String(p), HOST: "127.0.0.1", SIMULATOR: "off", SHUTDOWN_DRAIN_MS: "10000" });
    await waitFor(async () => ((await fetch(`http://127.0.0.1:${p}/readyz`).then((r) => r.status).catch(() => 0)) === 200 ? true : undefined), "the API");
    const t0 = Date.now();
    api.child.kill("SIGTERM");
    await waitFor(() => (/shutting down/.test(api.output()) ? true : undefined), "the first signal to land", 3000);
    api.child.kill("SIGINT");
    assert.equal(await api.exited, 1);
    assert.ok(Date.now() - t0 < 5000, "didn't wait out the 10 s drain");
  });

  it("pay-out worker: a provider call in flight finishes (paid) before the process exits 0", async () => {
    // Fixtures in the shared test database's public schema (the processes use it).
    const owner = createDb(TEST_DATABASE_URL, { max: 1 });
    onTestFinished(() => owner.end());
    const id = `sd${Date.now()}`;
    await owner.query("INSERT INTO orgs (id, name) VALUES ($1, 'Shutdown org')", [`org_${id}`]);
    await owner.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, 'A', 'x', now()), ($3, $4, 'B', 'x', now())", [
      `u1_${id}`,
      `a_${id}@t.co`,
      `u2_${id}`,
      `b_${id}@t.co`,
    ]);
    await owner.query("INSERT INTO balances (org_id, currency, available, reserved, updated_at) VALUES ($1, 'USD', 0, 500, now())", [`org_${id}`]);
    await owner.query(
      `INSERT INTO payouts (id, org_id, amount, currency, beneficiary_name, account_number, status, version, created_by, decided_by, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, 500, 'USD', 'Payee', 'GB1234', 'approved', 2, $3, $4, now(), now(), now())`,
      [`po_${id}`, `org_${id}`, `u1_${id}`, `u2_${id}`],
    );

    const worker = start("src/worker.ts", {
      WORKER_POLL_MS: "100",
      PROVIDER_DECLINE_RATE: "0",
      PROVIDER_TRANSIENT_RATE: "0",
      PROVIDER_MIN_LATENCY_MS: "1500",
      PROVIDER_MAX_LATENCY_MS: "1500",
    });
    const status = async () => (await owner.query<{ status: string }>("SELECT status FROM payouts WHERE id = $1", [`po_${id}`])).rows[0]!.status;
    await waitFor(async () => ((await status()) === "processing" ? true : undefined), "the worker to claim the pay-out");

    worker.child.kill("SIGTERM"); // mid provider call
    assert.equal(await worker.exited, 0, worker.output());
    assert.equal(await status(), "paid", "the in-flight call was finished, not abandoned");
    const { rows } = await owner.query<{ available: number; reserved: number }>("SELECT available, reserved FROM balances WHERE org_id = $1", [`org_${id}`]);
    assert.deepEqual(rows[0], { available: 0, reserved: 0 });
    assert.match(worker.output(), /shutdown complete/);
  });

  it("webhook and reports workers stop promptly when idle", async () => {
    for (const entry of ["src/webhook-worker.ts", "src/reports-worker.ts"]) {
      const proc = start(entry, { WEBHOOK_POLL_MS: "5000", EXPORT_POLL_MS: "5000" });
      await waitFor(() => (/worker started/.test(proc.output()) ? true : undefined), `${entry} to start`);
      const t0 = Date.now();
      proc.child.kill("SIGTERM");
      assert.equal(await proc.exited, 0, proc.output());
      assert.ok(Date.now() - t0 < 3000, `${entry} didn't sit out its 5 s poll interval`);
      assert.match(proc.output(), /shutdown complete/);
    }
  });
});

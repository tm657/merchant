import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { fakeClock, makeTestApp } from "./test/helpers.js";
import { openStream } from "./test/sse.js";

describe("events across API instances", () => {
  it("an event published by one instance reaches an SSE client on another", async () => {
    const clock = fakeClock(Date.now());
    const a = await makeTestApp(clock);
    // Instance B: same Postgres and same Redis prefix, separate process state and connections.
    const b = await makeTestApp(clock, { db: a.db, redisPrefix: a.redisPrefix });

    const url = await a.app.listen({ port: 0, host: "127.0.0.1" });
    const stream = await openStream(url, await a.tokenFor("admin@test.com"));
    try {
      await b.bus.publish("org_1", { type: "transactions", count: 1 });
      assert.deepEqual(await stream.next("transactions"), { count: 1 });
      await b.bus.publish("org_1", { type: "balance", currency: "IDR", available: 15_000, reserved: 0 });
      assert.deepEqual(await stream.next("balance"), { currency: "IDR", available: 15_000, reserved: 0 });
    } finally {
      stream.close();
    }
  });

  it("still filters balance events by role", async () => {
    const clock = fakeClock(Date.now());
    const a = await makeTestApp(clock);
    const b = await makeTestApp(clock, { db: a.db, redisPrefix: a.redisPrefix });
    const url = await a.app.listen({ port: 0, host: "127.0.0.1" });
    const stream = await openStream(url, await a.tokenFor("support@test.com"));
    try {
      await b.bus.publish("org_1", { type: "balance", currency: "USD", available: 1, reserved: 0 });
      await b.bus.publish("org_1", { type: "transactions", count: 2 });
      // The transactions event arrives; the balance event before it never does.
      assert.deepEqual(await stream.next("transactions"), { count: 2 });
      await assert.rejects(stream.next("balance", 300));
    } finally {
      stream.close();
    }
  });

  it("does not deliver another org's events", async () => {
    const a = await makeTestApp();
    const got: unknown[] = [];
    const unsubscribe = await a.bus.subscribe("org_1", (e) => got.push(e));
    await a.bus.publish("org_2", { type: "transactions", count: 1 });
    await a.bus.publish("org_1", { type: "transactions", count: 3 });
    await new Promise((r) => setTimeout(r, 100));
    unsubscribe();
    assert.deepEqual(got, [{ type: "transactions", count: 3 }]);
  });

  it("drops malformed messages instead of forwarding them", async () => {
    const a = await makeTestApp();
    const got: unknown[] = [];
    const unsubscribe = await a.bus.subscribe("org_1", (e) => got.push(e));
    await a.redis.publish(`${a.redisPrefix}events:org:org_1`, "not json");
    await a.redis.publish(`${a.redisPrefix}events:org:org_1`, JSON.stringify({ type: "balance", currency: "EUR", available: 1.5 }));
    await a.bus.publish("org_1", { type: "transactions", count: 1 });
    await new Promise((r) => setTimeout(r, 100));
    unsubscribe();
    assert.deepEqual(got, [{ type: "transactions", count: 1 }]);
  });
});

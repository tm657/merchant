import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgEventsProvider, useOrgEvents } from "@/components/OrgEvents";
import { useEffect, useState } from "react";
import { renderWithQuery } from "./render";
import { FakeEventSource } from "./setup";

function Probe() {
  const { status, subscribe } = useOrgEvents();
  const [balances, setBalances] = useState<string[]>([]);
  useEffect(() => subscribe("balance", (b) => setBalances((xs) => [...xs, `${b.currency}:${b.available}`])), [subscribe]);
  return (
    <>
      <p data-testid="status">{status}</p>
      <p data-testid="balances">{balances.join(",")}</p>
    </>
  );
}

function setup() {
  const view = renderWithQuery(
    <OrgEventsProvider orgId="org_1">
      <Probe />
    </OrgEventsProvider>,
  );
  const invalidate = vi.spyOn(view.client, "invalidateQueries");
  return { ...view, invalidate };
}

const status = () => screen.getByTestId("status").textContent;
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("OrgEventsProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the ±20% jitter to its middle so delays are exact: 1 s, 2 s, 4 s, ...
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens one stream for the org and goes live", () => {
    setup();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest.url).toBe("/api/orgs/org_1/events");
    expect(status()).toBe("connecting");
    act(() => FakeEventSource.latest.open());
    expect(status()).toBe("live");
  });

  it("reconnects with exponential backoff, and a successful open resets it", () => {
    setup();
    act(() => FakeEventSource.latest.open());

    const failAndExpectRetryAfter = (ms: number) => {
      const before = FakeEventSource.instances.length;
      const dead = FakeEventSource.latest;
      act(() => dead.fail());
      expect(dead.closed).toBe(true);
      expect(status()).toBe("reconnecting");
      advance(ms - 1);
      expect(FakeEventSource.instances).toHaveLength(before);
      advance(1);
      expect(FakeEventSource.instances).toHaveLength(before + 1);
    };

    failAndExpectRetryAfter(1000);
    failAndExpectRetryAfter(2000);
    failAndExpectRetryAfter(4000);
    failAndExpectRetryAfter(8000);
    act(() => FakeEventSource.latest.open());
    expect(status()).toBe("live");
    failAndExpectRetryAfter(1000);
  });

  it("caps the delay at 30 s", () => {
    setup();
    for (const ms of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      act(() => FakeEventSource.latest.fail());
      const n = FakeEventSource.instances.length;
      advance(ms - 1);
      expect(FakeEventSource.instances).toHaveLength(n);
      advance(1);
      expect(FakeEventSource.instances).toHaveLength(n + 1);
    }
  });

  it("resyncs live state on every open, the first included; transactions only after a reconnect", () => {
    const { invalidate } = setup();
    act(() => FakeEventSource.latest.open());
    // Events between the server render and this first open went to nobody.
    for (const key of ["balances", "payouts", "payout", "exports"]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key, "org_1"] });
    }
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["transactions", "org_1"], refetchType: "none" });

    act(() => FakeEventSource.latest.fail());
    advance(1000);
    invalidate.mockClear();
    act(() => FakeEventSource.latest.open());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["balances", "org_1"] });
    // Visible rows don't jump; the list is refetched when the user next asks.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["transactions", "org_1"], refetchType: "none" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["payouts", "org_1"] });
  });

  it("delivers valid events to subscribers and drops malformed ones", () => {
    setup();
    act(() => FakeEventSource.latest.open());
    act(() => FakeEventSource.latest.emit("balance", { currency: "USD", available: 100, reserved: 0 }));
    act(() => FakeEventSource.latest.emit("balance", { currency: "EUR", available: 1.5 }));
    expect(screen.getByTestId("balances").textContent).toBe("USD:100");
  });

  it("closes the stream on unmount and doesn't reconnect afterwards", () => {
    const { unmount } = setup();
    const source = FakeEventSource.latest;
    act(() => source.fail());
    unmount();
    advance(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

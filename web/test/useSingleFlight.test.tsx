import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSingleFlight } from "@/lib/useSingleFlight";

describe("useSingleFlight", () => {
  it("drops calls made while one is in flight, then allows the next", async () => {
    const { result } = renderHook(() => useSingleFlight());
    let release!: () => void;
    let runs = 0;
    const slow = () => new Promise<void>((r) => {
      runs++;
      release = r;
    });
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current(slow);
      second = result.current(slow);
    });
    expect(await second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
    await act(async () => {
      const third = result.current(async () => {
        runs++;
      });
      expect(await third).toBe(true);
    });
    expect(runs).toBe(2);
  });

  it("frees itself when the call fails", async () => {
    const { result } = renderHook(() => useSingleFlight());
    await expect(result.current(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await result.current(async () => {})).toBe(true);
  });
});

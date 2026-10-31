import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "@/components/FilterBar";
import { DEFAULT_DIR, DEFAULT_SORT } from "@mini-payments/shared";
import type { Filters } from "@/lib/filters";

const base: Filters = { sort: DEFAULT_SORT, dir: DEFAULT_DIR };

describe("FilterBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  // No real waits inside user-event: the test moves the fake clock itself, so the
  // pauses between keystrokes are exact.
  const user = () => userEvent.setup({ delay: null });
  /** Types one character at a time, `gapMs` of fake time apart. */
  async function typeSlowly(el: HTMLElement, text: string, gapMs: number) {
    const u = user();
    for (const ch of text) {
      await u.type(el, ch);
      act(() => vi.advanceTimersByTime(gapMs));
    }
  }

  it("debounces the search: one change, 300 ms after typing stops, as a URL replace", async () => {
    const onChange = vi.fn();
    render(<FilterBar filters={base} onChange={onChange} />);
    await typeSlowly(screen.getByLabelText("Counterparty"), "grab", 50);
    // 50 ms after the last key: nothing sent yet.
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(249));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ q: "grab" }, { replace: true });
  });

  it("restarts the wait on each keystroke and trims, and clearing the box removes q", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar filters={base} onChange={onChange} />);
    const box = screen.getByLabelText("Counterparty");
    // Each key comes 250 ms after the last: the 300 ms wait keeps restarting.
    await typeSlowly(box, "  sh", 250);
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(50));
    expect(onChange.mock.calls).toEqual([[{ q: "sh" }, { replace: true }]]);

    rerender(<FilterBar filters={{ ...base, q: "sh" }} onChange={onChange} />);
    await user().clear(box);
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenLastCalledWith({ q: undefined }, { replace: true });
  });

  it("follows the URL when it changes from elsewhere (back button), without firing a change", () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar filters={{ ...base, q: "old" }} onChange={onChange} />);
    rerender(<FilterBar filters={{ ...base, q: "new" }} onChange={onChange} />);
    expect((screen.getByLabelText("Counterparty") as HTMLInputElement).value).toBe("new");
    act(() => vi.advanceTimersByTime(1000));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("changes selects at once, and Clear filters resets every filter (not sort)", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar filters={base} onChange={onChange} />);
    await user().selectOptions(screen.getByLabelText("Type"), "payout");
    expect(onChange).toHaveBeenLastCalledWith({ type: "payout" });
    await user().selectOptions(screen.getByLabelText("Status"), "success");
    expect(onChange).toHaveBeenLastCalledWith({ status: "success" });

    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    rerender(<FilterBar filters={{ ...base, type: "payout", currency: "IDR" }} onChange={onChange} />);
    await user().click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenLastCalledWith({
      type: undefined,
      status: undefined,
      currency: undefined,
      from: undefined,
      to: undefined,
      q: undefined,
    });
  });
});

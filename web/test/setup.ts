// Shared test harness for the web app: jsdom gaps, Next.js mocks, MSW and a fake EventSource.
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { useSyncExternalStore } from "react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

// ---- Fake timers: React Testing Library advances them only if it sees a `jest` global.
// Vitest's fake setTimeout carries the same marker, so this shim lets RTL drive them
// instead of waiting forever on a timer that never fires.
(globalThis as unknown as { jest: { advanceTimersByTime: (ms: number) => void } }).jest = {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
};

// ---- MSW: every BFF call is answered by a handler the test sets, or the test fails ----
export const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());

// Node's fetch needs absolute URLs; the browser resolves "/api/..." against the page.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  realFetch(typeof input === "string" ? new URL(input, window.location.href) : input, init)) as typeof fetch;

// ---- <dialog>: jsdom has no showModal/close; behave like the browser closely enough ----
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  // Escape on a modal dialog fires "cancel" (the component decides whether to close).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const dialog = (e.target as Element | null)?.closest?.("dialog[open]");
    dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
}

// ---- next/navigation: search params follow history.pushState, like the App Router ----
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
for (const method of ["pushState", "replaceState"] as const) {
  const original = window.history[method].bind(window.history);
  window.history[method] = (...args: Parameters<History["pushState"]>) => {
    original(...args);
    notify();
  };
}
window.addEventListener("popstate", notify);
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    const search = useSyncExternalStore(subscribe, () => window.location.search);
    return new URLSearchParams(search);
  },
  usePathname: () => useSyncExternalStore(subscribe, () => window.location.pathname),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
  };
});

// ---- EventSource: jsdom has none. Tests drive it through FakeEventSource.instances ----
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private handlers = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  // Test controls:
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
  emit(type: string, data: unknown) {
    for (const fn of this.handlers.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  static get latest(): FakeEventSource {
    const s = FakeEventSource.instances.at(-1);
    if (!s) throw new Error("no EventSource was created");
    return s;
  }
}
vi.stubGlobal("EventSource", FakeEventSource);
afterEach(() => {
  FakeEventSource.instances = [];
});

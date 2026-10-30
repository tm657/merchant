import type { Currency } from "./db.js";

export type OrgEvent =
  | { type: "balance"; currency: Currency; available: number }
  | { type: "transactions"; count: number };

type Listener = (event: OrgEvent) => void;

/** In-process pub/sub, keyed by org. */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(orgId: string, listener: Listener): () => void {
    let set = this.listeners.get(orgId);
    if (!set) {
      set = new Set();
      this.listeners.set(orgId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(orgId);
    };
  }

  publish(orgId: string, event: OrgEvent): void {
    for (const listener of this.listeners.get(orgId) ?? []) listener(event);
  }
}

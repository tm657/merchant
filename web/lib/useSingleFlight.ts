"use client";

import { useCallback, useRef } from "react";

/**
 * Runs `fn` only if no earlier call is still in flight. A disabled button (from isPending
 * or other state) only takes effect after React re-renders, so two clicks in the same
 * tick would otherwise both start the action. Returns false when the call was dropped.
 */
export function useSingleFlight() {
  const busy = useRef(false);
  return useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      await fn();
      return true;
    } finally {
      busy.current = false;
    }
  }, []);
}

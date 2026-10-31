"use client";

import { useState } from "react";

/**
 * The Prev/Next cursor stack for one set of filters (`key`). When the key changes, the
 * stack is dropped for good: going back to an earlier key (browser back/forward) starts at
 * page 1 again, so the same URL always shows the same page, as it would after a reload.
 */
export function useCursorStack(key: string) {
  const [pager, setPager] = useState<{ key: string; stack: string[] }>({ key, stack: [] });
  // Adjusting state during render (not in an effect) avoids a frame with the stale stack.
  if (pager.key !== key) setPager({ key, stack: [] });
  const stack = pager.key === key ? pager.stack : [];
  return {
    stack,
    cursor: stack.at(-1) ?? null,
    setStack: (next: string[]) => setPager({ key, stack: next }),
  };
}

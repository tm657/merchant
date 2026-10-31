"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const AnnounceContext = createContext<((message: string) => void) | null>(null);

/**
 * One polite aria-live region for the page. announce() is for outcomes and live status
 * changes ("Pay-out approved"); errors that need attention use role="alert" where they
 * appear instead.
 */
export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const announce = useCallback((next: string) => {
    clearTimeout(timer.current);
    // Clear first so the same sentence twice is still announced. The short delay also
    // lets a closing modal dialog release the page (inert content isn't announced).
    setMessage("");
    timer.current = setTimeout(() => setMessage(next), 150);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): (message: string) => void {
  const announce = useContext(AnnounceContext);
  if (!announce) throw new Error("useAnnounce must be used inside <LiveRegionProvider>");
  return announce;
}

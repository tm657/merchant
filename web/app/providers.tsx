"use client";

// Before anything parses: see the file.
import "@/lib/zod-config";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { BffError } from "@/lib/bff-client";

function toLoginOnUnauthenticated(err: unknown) {
  // The session expired or was revoked: a full page load also drops all cached data.
  if (err instanceof BffError && err.status === 401) {
    const next = window.location.pathname + window.location.search;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full load: drops the router cache and hidden <Activity> pages from the previous session
    window.location.assign(`/login?expired=1&next=${encodeURIComponent(next)}`);
  }
}

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session (and per request on the server).
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: toLoginOnUnauthenticated }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // 4xx answers (auth, bad cursor) will not change on retry.
            retry: (count, err) => !(err instanceof BffError && err.status < 500) && count < 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

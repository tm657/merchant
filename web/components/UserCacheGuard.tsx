"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

// The user whose data is in the cache. Module scope: one per browser tab.
let cachedForUser: string | null = null;

/**
 * Clears the query cache if the signed-in user changes without a full page load
 * (for example, a different account logged in from another tab). Login and logout
 * already clear it themselves.
 */
export function UserCacheGuard({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (cachedForUser !== null && cachedForUser !== userId) queryClient.clear();
    cachedForUser = userId;
  }, [userId, queryClient]);
  return null;
}

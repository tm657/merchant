"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { bffPost } from "@/lib/bff-client";

export function LogoutButton() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    await bffPost("/api/auth/logout").catch(() => undefined);
    queryClient.clear();
    // Full page load: also drops the router cache and any hidden (Activity) pages.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full load: drops the router cache and hidden <Activity> pages from the previous session
    window.location.assign("/login");
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={pending}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {pending ? "Logging out…" : "Log out"}
    </button>
  );
}

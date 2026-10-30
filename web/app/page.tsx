import Link from "next/link";
import { Suspense } from "react";
import { LogoutButton } from "@/components/LogoutButton";
import { UserCacheGuard } from "@/components/UserCacheGuard";
import { requireUser } from "@/lib/auth.server";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Mini Payments</p>
      <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />}>
        <OrgList />
      </Suspense>
    </main>
  );
}

async function OrgList() {
  const me = await requireUser();
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Hi, {me.user.name}</h1>
        <LogoutButton />
      </div>
      <UserCacheGuard userId={me.user.id} />
      {me.memberships.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          You are not a member of any organization yet. Ask an admin to add you.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {me.memberships.map((m) => (
            <li key={m.orgId}>
              <Link
                href={`/orgs/${m.orgId}/transactions`}
                className="flex items-center justify-between rounded-lg border border-zinc-200 p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <span className="font-medium">{m.orgName}</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">{m.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import Link from "next/link";
import { Suspense } from "react";
import { LogoutButton } from "@/components/LogoutButton";
import { OrgNav } from "@/components/OrgNav";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { UserCacheGuard } from "@/components/UserCacheGuard";
import { requireUser } from "@/lib/auth.server";

export default function OrgLayout({ children, params }: LayoutProps<"/orgs/[orgId]">) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      {/* The session is request-time data, so the header streams in behind Suspense. */}
      <Suspense fallback={<div className="h-10 rounded-lg bg-zinc-100 dark:bg-zinc-900" />}>
        <Header params={params} />
      </Suspense>
      <main>{children}</main>
    </div>
  );
}

async function Header({ params }: { params: LayoutProps<"/orgs/[orgId]">["params"] }) {
  const [me, { orgId }] = await Promise.all([requireUser(), params]);
  const current = me.memberships.find((m) => m.orgId === orgId);

  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Mini Payments
        </Link>
        {current && <span className="text-sm font-medium">{current.orgName}</span>}
      </div>
      {current && <OrgNav orgId={orgId} role={current.role} />}
      <OrgSwitcher memberships={me.memberships} currentOrgId={orgId} />
      <div className="flex items-center gap-3 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">
          {me.user.name}
          {current && <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">{current.role}</span>}
        </span>
        <LogoutButton />
      </div>
      <UserCacheGuard userId={me.user.id} />
    </header>
  );
}

import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessDenied } from "@/components/AccessDenied";
import { BalanceCards } from "@/components/BalanceCards";
import { LiveRegionProvider } from "@/components/LiveRegion";
import { OrgEventsProvider } from "@/components/OrgEvents";
import { TableSkeleton } from "@/components/TableSkeleton";
import { fetchBalances, fetchPayouts, UpstreamError } from "@/lib/api.server";
import { requireUser } from "@/lib/auth.server";
import { log } from "@/lib/log.server";
import { parsePayoutFilters } from "@/lib/payout-filters";
import { can, orgIdSchema } from "@mini-payments/shared";
import { PayoutsView } from "./PayoutsView";

type Props = PageProps<"/orgs/[orgId]/payouts">;

export default function PayoutsPage({ params, searchParams }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Pay-outs</h1>
      {/* params and searchParams are request-time data, so they are read inside Suspense. */}
      <Suspense fallback={<TableSkeleton withFilterBar label="Loading pay-outs" />}>
        <Payouts params={params} searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Payouts({ params, searchParams }: Props) {
  // Always render at request time: this data is uncached and must never be prerendered.
  await connection();
  const { orgId } = await params;
  if (!orgIdSchema.safeParse(orgId).success) notFound();

  // The API checks the session, membership and role again on every call below; these
  // checks only decide what to render.
  const me = await requireUser();
  const membership = me.memberships.find((m) => m.orgId === orgId);
  if (!membership || !can(membership.role, "payout:read")) return <AccessDenied />;
  const showBalances = can(membership.role, "balances:read");

  const filters = parsePayoutFilters(await searchParams);
  const query = new URLSearchParams(filters.status ? { status: filters.status } : {});

  const [page, balances] = await Promise.allSettled([
    fetchPayouts(orgId, query),
    showBalances ? fetchBalances(orgId) : Promise.resolve(null),
  ]);
  for (const r of [page, balances]) {
    if (r.status === "fulfilled") continue;
    const err = r.reason;
    if (err instanceof UpstreamError && err.status === 401) redirect("/login?expired=1");
    if (err instanceof UpstreamError && err.status === 403) return <AccessDenied />;
    // Anything else: the client retries through the BFF and shows its error state.
    await log.warn("initial pay-outs fetch failed", { err });
  }

  return (
    <OrgEventsProvider orgId={orgId}>
      <LiveRegionProvider>
        <div className="flex flex-col gap-8">
          {showBalances && (
            <BalanceCards orgId={orgId} initialBalances={balances.status === "fulfilled" ? balances.value : null} />
          )}
          <PayoutsView
            orgId={orgId}
            role={membership.role}
            currentUserId={me.user.id}
            initialPage={page.status === "fulfilled" ? page.value : null}
            initialStatus={filters.status ?? null}
          />
        </div>
      </LiveRegionProvider>
    </OrgEventsProvider>
  );
}

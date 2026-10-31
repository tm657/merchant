import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessDenied } from "@/components/AccessDenied";
import { BalanceCards } from "@/components/BalanceCards";
import { OrgEventsProvider } from "@/components/OrgEvents";
import { TableSkeleton } from "@/components/TableSkeleton";
import { fetchBalances, fetchTransactions, UpstreamError } from "@/lib/api.server";
import { requireUser } from "@/lib/auth.server";
import { can, orgIdSchema } from "@mini-payments/shared";
import { filtersToSearch, pageQuery, parseFilters } from "@/lib/filters";
import { TransactionsView } from "./TransactionsView";

type Props = PageProps<"/orgs/[orgId]/transactions">;

export default function TransactionsPage({ params, searchParams }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
      {/* params and searchParams are request-time data, so they are read inside Suspense. */}
      <Suspense fallback={<TableSkeleton withFilterBar />}>
        <Transactions params={params} searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Transactions({ params, searchParams }: Props) {
  // Always render at request time: this data is uncached and must never be prerendered.
  await connection();
  const { orgId } = await params;
  if (!orgIdSchema.safeParse(orgId).success) notFound();

  // The API checks the session and membership again on every call below; this check
  // only decides what to render.
  const me = await requireUser();
  const membership = me.memberships.find((m) => m.orgId === orgId);
  if (!membership) return <AccessDenied />;
  const showBalances = can(membership.role, "balances:read");

  const filters = parseFilters(await searchParams);

  // First page and balances straight from the API (no BFF hop on the server), in parallel.
  const [page, balances] = await Promise.allSettled([
    fetchTransactions(orgId, pageQuery(filters, null)),
    showBalances ? fetchBalances(orgId) : Promise.resolve(null),
  ]);
  for (const r of [page, balances]) {
    if (r.status === "fulfilled") continue;
    const err = r.reason;
    if (err instanceof UpstreamError && err.status === 401) redirect("/login?expired=1");
    if (err instanceof UpstreamError && err.status === 403) return <AccessDenied />;
    // Anything else: the client retries through the BFF and shows its error state.
    console.error("Initial fetch failed:", err);
  }

  return (
    <OrgEventsProvider orgId={orgId}>
      <div className="flex flex-col gap-8">
        {showBalances && (
          <BalanceCards orgId={orgId} initialBalances={balances.status === "fulfilled" ? balances.value : null} />
        )}
        <TransactionsView
          orgId={orgId}
          initialPage={page.status === "fulfilled" ? page.value : null}
          initialFiltersKey={filtersToSearch(filters).toString()}
        />
      </div>
    </OrgEventsProvider>
  );
}

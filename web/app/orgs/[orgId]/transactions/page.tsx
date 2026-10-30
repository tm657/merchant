import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TableSkeleton } from "@/components/TableSkeleton";
import { fetchTransactions, UpstreamError } from "@/lib/api.server";
import { filtersToSearch, orgIdSchema, pageQuery, parseFilters, type TransactionsPage } from "@/lib/schemas";
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

  const filters = parseFilters(await searchParams);

  // First page straight from the API (no BFF hop on the server).
  let initialPage: TransactionsPage | null = null;
  try {
    initialPage = await fetchTransactions(orgId, pageQuery(filters, null));
  } catch (err) {
    if (err instanceof UpstreamError && err.code === "org_not_found") notFound();
    // Anything else: the client retries through the BFF and shows the error state.
    console.error("Initial transactions fetch failed:", err);
  }

  return (
    <TransactionsView
      orgId={orgId}
      initialPage={initialPage}
      initialFiltersKey={filtersToSearch(filters).toString()}
    />
  );
}

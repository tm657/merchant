import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessDenied } from "@/components/AccessDenied";
import { LiveRegionProvider } from "@/components/LiveRegion";
import { TableSkeleton } from "@/components/TableSkeleton";
import { fetchAudit, fetchMembers, UpstreamError } from "@/lib/api.server";
import { auditFiltersToSearch, parseAuditFilters } from "@/lib/audit-filters";
import { requireUser } from "@/lib/auth.server";
import { log } from "@/lib/log.server";
import { can, orgIdSchema } from "@mini-payments/shared";
import { AuditView } from "./AuditView";

type Props = PageProps<"/orgs/[orgId]/audit">;

export default function AuditPage({ params, searchParams }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <Suspense fallback={<TableSkeleton withFilterBar label="Loading audit log" />}>
        <Audit params={params} searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Audit({ params, searchParams }: Props) {
  await connection();
  const { orgId } = await params;
  if (!orgIdSchema.safeParse(orgId).success) notFound();

  // The API checks the role again on every call; this only decides what to render.
  const me = await requireUser();
  const membership = me.memberships.find((m) => m.orgId === orgId);
  if (!membership || !can(membership.role, "audit:read")) return <AccessDenied />;

  const filters = parseAuditFilters(await searchParams);
  const [page, members] = await Promise.allSettled([fetchAudit(orgId, auditFiltersToSearch(filters)), fetchMembers(orgId)]);
  for (const r of [page, members]) {
    if (r.status === "fulfilled") continue;
    const err = r.reason;
    if (err instanceof UpstreamError && err.status === 401) redirect("/login?expired=1");
    if (err instanceof UpstreamError && err.status === 403) return <AccessDenied />;
    await log.warn("initial audit fetch failed", { err });
  }

  return (
    <LiveRegionProvider>
      <AuditView
        orgId={orgId}
        canExport={can(membership.role, "audit:export")}
        members={members.status === "fulfilled" ? members.value.items : []}
        initialPage={page.status === "fulfilled" ? page.value : null}
        initialFiltersKey={auditFiltersToSearch(filters).toString()}
      />
    </LiveRegionProvider>
  );
}

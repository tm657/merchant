import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessDenied } from "@/components/AccessDenied";
import { LiveRegionProvider } from "@/components/LiveRegion";
import { OrgEventsProvider } from "@/components/OrgEvents";
import { TableSkeleton } from "@/components/TableSkeleton";
import { reportsApi, UpstreamError } from "@/lib/api.server";
import { requireUser } from "@/lib/auth.server";
import { log } from "@/lib/log.server";
import { can, orgIdSchema, settlementsQuerySchema } from "@mini-payments/shared";
import { ReportsView } from "./ReportsView";

type Props = PageProps<"/orgs/[orgId]/reports">;

export default function ReportsPage({ params, searchParams }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
      <Suspense fallback={<TableSkeleton label="Loading reports" rows={4} />}>
        <Reports params={params} searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

const DAY = 86_400_000;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Settlements cover finished UTC days: by default the 30 days ending yesterday. */
function settlementDefaults(now = Date.now()) {
  return { defaults: { from: utc(now - 30 * DAY), to: utc(now - DAY) }, yesterday: utc(now - DAY) };
}

async function Reports({ params, searchParams }: Props) {
  await connection();
  const { orgId } = await params;
  if (!orgIdSchema.safeParse(orgId).success) notFound();
  const me = await requireUser();
  const membership = me.memberships.find((m) => m.orgId === orgId);
  if (!membership || !can(membership.role, "reports:export")) return <AccessDenied />;

  const { defaults, yesterday } = settlementDefaults();
  const sp = await searchParams;
  const asked = settlementsQuerySchema.safeParse({ from: sp.from, to: sp.to });
  const range = asked.success ? asked.data : defaults;

  const [exports, settlements] = await Promise.allSettled([
    reportsApi.listExports(orgId),
    reportsApi.settlements(orgId, range.from, range.to),
  ]);
  for (const r of [exports, settlements]) {
    if (r.status === "fulfilled") continue;
    const err = r.reason;
    if (err instanceof UpstreamError && err.status === 401) redirect("/login?expired=1");
    if (err instanceof UpstreamError && err.status === 403) return <AccessDenied />;
    await log.warn("initial reports fetch failed", { err });
  }

  return (
    <OrgEventsProvider orgId={orgId}>
      <LiveRegionProvider>
        <ReportsView
          orgId={orgId}
          defaults={defaults}
          lastSettledDay={yesterday}
          initialExports={exports.status === "fulfilled" ? exports.value : null}
          initialSettlements={settlements.status === "fulfilled" ? settlements.value : null}
        />
      </LiveRegionProvider>
    </OrgEventsProvider>
  );
}

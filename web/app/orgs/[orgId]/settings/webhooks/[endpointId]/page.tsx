import { connection } from "next/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessDenied } from "@/components/AccessDenied";
import { LiveRegionProvider } from "@/components/LiveRegion";
import { TableSkeleton } from "@/components/TableSkeleton";
import { UpstreamError, webhooksApi } from "@/lib/api.server";
import { requireUser } from "@/lib/auth.server";
import { can, orgIdSchema, webhookEndpointIdSchema } from "@mini-payments/shared";
import { DeliveriesView } from "./DeliveriesView";

type Props = PageProps<"/orgs/[orgId]/settings/webhooks/[endpointId]">;

export default function EndpointPage({ params }: Props) {
  return (
    <Suspense fallback={<TableSkeleton label="Loading deliveries" />}>
      <Endpoint params={params} />
    </Suspense>
  );
}

async function Endpoint({ params }: { params: Props["params"] }) {
  await connection();
  const { orgId, endpointId } = await params;
  if (!orgIdSchema.safeParse(orgId).success || !webhookEndpointIdSchema.safeParse(endpointId).success) notFound();
  const me = await requireUser();
  const membership = me.memberships.find((m) => m.orgId === orgId);
  if (!membership || !can(membership.role, "webhooks:manage")) return <AccessDenied />;

  let endpoint;
  try {
    endpoint = (await webhooksApi.get(orgId, endpointId)).endpoint;
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) redirect("/login?expired=1");
    if (err instanceof UpstreamError && err.status === 403) return <AccessDenied />;
    if (err instanceof UpstreamError && err.status === 404) notFound();
    throw err;
  }

  return (
    <section className="flex flex-col gap-4">
      <Link href={`/orgs/${encodeURIComponent(orgId)}/settings/webhooks`} className="text-sm font-medium underline">
        ← All endpoints
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Deliveries</h1>
      <p className="break-all font-mono text-sm">{endpoint.url}</p>
      <LiveRegionProvider>
        <DeliveriesView orgId={orgId} endpointId={endpointId} enabled={endpoint.enabled} />
      </LiveRegionProvider>
    </section>
  );
}

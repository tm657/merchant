import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessDenied } from "@/components/AccessDenied";
import { LiveRegionProvider } from "@/components/LiveRegion";
import { TableSkeleton } from "@/components/TableSkeleton";
import { UpstreamError, webhooksApi } from "@/lib/api.server";
import { requireUser } from "@/lib/auth.server";
import { log } from "@/lib/log.server";
import { can, orgIdSchema } from "@mini-payments/shared";
import { WebhooksView } from "./WebhooksView";

type Props = PageProps<"/orgs/[orgId]/settings/webhooks">;

export default function WebhooksPage({ params }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
      <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        We POST signed JSON to your endpoints when pay-outs change and when transactions arrive. Verify the{" "}
        <code className="font-mono">Webhook-Signature</code> header with your endpoint&apos;s secret.
      </p>
      <Suspense fallback={<TableSkeleton label="Loading webhook endpoints" rows={3} />}>
        <Webhooks params={params} />
      </Suspense>
    </section>
  );
}

async function Webhooks({ params }: { params: Props["params"] }) {
  await connection();
  const { orgId } = await params;
  if (!orgIdSchema.safeParse(orgId).success) notFound();
  const me = await requireUser();
  const membership = me.memberships.find((m) => m.orgId === orgId);
  if (!membership || !can(membership.role, "webhooks:manage")) return <AccessDenied />;

  let initial = null;
  try {
    initial = await webhooksApi.list(orgId);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) redirect("/login?expired=1");
    if (err instanceof UpstreamError && err.status === 403) return <AccessDenied />;
    await log.warn("initial webhooks fetch failed", { err });
  }
  return (
    <LiveRegionProvider>
      <WebhooksView orgId={orgId} initial={initial} />
    </LiveRegionProvider>
  );
}

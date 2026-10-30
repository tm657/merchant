import { Suspense } from "react";
import { OrgSwitcher } from "@/components/OrgSwitcher";

export default function OrgLayout({ children, params }: LayoutProps<"/orgs/[orgId]">) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <span className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Mini Payments</span>
        <Suspense fallback={<div className="h-9 w-64 rounded-lg bg-zinc-100 dark:bg-zinc-900" />}>
          <CurrentOrgSwitcher params={params} />
        </Suspense>
      </header>
      <main>{children}</main>
    </div>
  );
}

async function CurrentOrgSwitcher({ params }: { params: LayoutProps<"/orgs/[orgId]">["params"] }) {
  const { orgId } = await params;
  return <OrgSwitcher currentOrgId={orgId} />;
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { can, type Role } from "@mini-payments/shared";

export function OrgNav({ orgId, role }: { orgId: string; role: Role }) {
  const pathname = usePathname();
  const base = `/orgs/${encodeURIComponent(orgId)}`;
  // Hidden links are only tidiness: the API refuses these pages' data to other roles.
  const links = [
    { href: `${base}/transactions`, label: "Transactions", show: true },
    { href: `${base}/payouts`, label: "Pay-outs", show: can(role, "payout:read") },
    { href: `${base}/reports`, label: "Reports", show: can(role, "reports:export") },
    { href: `${base}/audit`, label: "Audit log", show: can(role, "audit:read") },
    { href: `${base}/settings/webhooks`, label: "Webhooks", show: can(role, "webhooks:manage") },
  ].filter((l) => l.show);
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-1 text-sm">
      {links.map(({ href, label }) => {
        const current = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 font-medium ${current ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

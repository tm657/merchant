"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function OrgNav({ orgId }: { orgId: string }) {
  const pathname = usePathname();
  const base = `/orgs/${encodeURIComponent(orgId)}`;
  const links = [
    { href: `${base}/transactions`, label: "Transactions" },
    { href: `${base}/payouts`, label: "Pay-outs" },
  ];
  return (
    <nav aria-label="Sections" className="flex gap-1 text-sm">
      {links.map(({ href, label }) => {
        const current = pathname === href;
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

import Link from "next/link";
import { ORG_IDS } from "@/lib/schemas";

export function OrgSwitcher({ currentOrgId }: { currentOrgId: string }) {
  return (
    <nav aria-label="Organization">
      <ul className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
        {ORG_IDS.map((orgId) => {
          const current = orgId === currentOrgId;
          return (
            <li key={orgId}>
              <Link
                href={`/orgs/${orgId}/transactions`}
                aria-current={current ? "page" : undefined}
                className={`block rounded-md px-3 py-1.5 text-sm font-medium ${
                  current
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {orgId}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

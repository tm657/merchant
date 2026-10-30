import Link from "next/link";
import type { Me } from "@/lib/schemas";

/** Lists only the orgs the user is a member of. */
export function OrgSwitcher({ memberships, currentOrgId }: { memberships: Me["memberships"]; currentOrgId: string }) {
  if (memberships.length <= 1) return null;
  return (
    <nav aria-label="Organization">
      <ul className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
        {memberships.map(({ orgId, orgName }) => {
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
                {orgName}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

import type { Role } from "./schemas";

// Mirrors api/src/auth/permissions.ts. This copy only hides or disables UI.
// The API is the real enforcement: it rejects these requests regardless of what the UI shows.
export type Permission = "transactions:read" | "balances:read";

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: ["transactions:read", "balances:read"],
  finance: ["transactions:read", "balances:read"],
  support: ["transactions:read"],
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

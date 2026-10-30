import type { Role } from "../db.js";

// Mirrored in web/lib/permissions.ts for hiding UI. This copy is the one that's enforced.
export const PERMISSIONS = ["transactions:read", "balances:read"] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: ["transactions:read", "balances:read"],
  finance: ["transactions:read", "balances:read"],
  support: ["transactions:read"],
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

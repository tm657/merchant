/** Org roles, from most to least access. */
export const ROLES = ["admin", "finance", "support"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = ["transactions:read", "balances:read"] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: ["transactions:read", "balances:read"],
  finance: ["transactions:read", "balances:read"],
  support: ["transactions:read"],
};

/**
 * One map for both apps. The API enforces it on every request. The web app uses it
 * only to hide or disable UI, which is never a security boundary.
 */
export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

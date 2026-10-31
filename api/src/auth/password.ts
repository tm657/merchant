import argon2 from "argon2";

// Length limits live in @mini-payments/shared (PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH).
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@mini-payments/shared";

// OWASP's argon2id baseline: 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

/** argon2.verify compares in constant time. A malformed hash counts as a mismatch. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * For logins with an unknown email: does the same work as a real check, so response
 * time doesn't reveal whether the account exists. Always false.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("not-a-real-password-used-for-timing-only");
  await verifyPassword(await dummyHash, password);
  return false;
}

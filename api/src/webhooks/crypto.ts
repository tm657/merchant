import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

/** The 32-byte key from WEBHOOK_SECRET_KEY (base64). */
export function parseSecretKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("WEBHOOK_SECRET_KEY must decode to 32 bytes");
  return key;
}

/** A new signing secret: shown to the user once, stored only encrypted. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * AES-256-GCM with a random 96-bit IV. `aad` (the endpoint id) is authenticated but not
 * stored, so a ciphertext copied onto another endpoint's row fails to decrypt.
 * Format: v1:<iv>:<tag>:<ciphertext>, each base64url.
 */
export function encryptSecret(key: Buffer, secret: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
}

/** Throws if the value was tampered with, or the key or aad is wrong. */
export function decryptSecret(key: Buffer, stored: string, aad: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error("unrecognised secret format");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * The Webhook-Signature header: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>.
 * One v1 per secret: during a rotation's grace period both the new and the old secret sign.
 */
export function signatureHeader(secrets: readonly string[], body: string, timestampSeconds: number): string {
  const signed = `${timestampSeconds}.${body}`;
  const sigs = secrets.map((s) => `v1=${createHmac("sha256", s).update(signed, "utf8").digest("hex")}`);
  return [`t=${timestampSeconds}`, ...sigs].join(",");
}

/**
 * A local webhook receiver for demos. It verifies each request's signature the way a
 * real integration should, then prints the event.
 *
 *   WEBHOOK_SECRET=whsec_... npx tsx scripts/webhook-receiver.ts
 *
 * Env:
 *   WEBHOOK_SECRET        the endpoint's secret (shown once when created or rotated). During
 *                         a rotation, pass both, comma-separated: new,old
 *   RECEIVER_PORT         default 4500 (listens on 127.0.0.1 only)
 *   RECEIVER_FAIL_RATE    0..1, answer that share of requests with 500 to watch retries
 *
 * Point an endpoint at http://127.0.0.1:4500/webhooks. Locally the API needs
 * WEBHOOK_ALLOW_PRIVATE_TARGETS=true for that (never in production).
 */
import {
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  webhookEventSchema,
} from "@mini-payments/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: string };

/**
 * Checks a `t=<unix>,v1=<hex>[,v1=<hex>]` header against the raw body. Valid if the
 * timestamp is within the tolerance (replay protection) and any v1 matches any secret.
 * Compare the raw bytes you received: re-serialized JSON won't match.
 */
export function verifyWebhookSignature(
  header: string | undefined,
  rawBody: string,
  secrets: readonly string[],
  { toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS, nowMs = Date.now() } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "missing signature header" };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t" && v && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (timestamp === null) return { ok: false, reason: "no timestamp" };
  if (signatures.length === 0) return { ok: false, reason: "no v1 signature" };
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };

  const signed = `${timestamp}.${rawBody}`;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(signed, "utf8").digest();
    for (const sig of signatures) {
      // Constant time: don't leak how much of a guess was right.
      if (timingSafeEqual(expected, Buffer.from(sig, "hex"))) return { ok: true, timestamp };
    }
  }
  return { ok: false, reason: "signature mismatch" };
}

const MAX_BODY_BYTES = 1024 * 1024;

function main() {
  const secrets = (process.env.WEBHOOK_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0) {
    console.error("Set WEBHOOK_SECRET to the endpoint's secret (whsec_...).");
    process.exit(1);
  }
  const port = Number(process.env.RECEIVER_PORT ?? 4500);
  const failRate = Number(process.env.RECEIVER_FAIL_RATE ?? 0);
  // Deliveries are at-least-once: the same event id can arrive more than once.
  const seen = new Set<string>();

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const id = String(req.headers[WEBHOOK_ID_HEADER] ?? "?");
      const type = String(req.headers[WEBHOOK_EVENT_HEADER] ?? "?");
      const result = verifyWebhookSignature(req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined, raw, secrets);
      const time = new Date().toISOString().slice(11, 19);
      if (!result.ok) {
        console.log(`${time}  ✗ rejected ${type} ${id}: ${result.reason}`);
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: result.reason }));
        return;
      }
      if (Math.random() < failRate) {
        console.log(`${time}  ↻ simulated failure for ${type} ${id} (the sender will retry)`);
        res.writeHead(500).end();
        return;
      }
      const duplicate = seen.has(id);
      seen.add(id);
      const event = webhookEventSchema.safeParse(JSON.parse(raw));
      const summary = !event.success
        ? "(unrecognised body)"
        : "payout" in event.data.data
          ? `${event.data.data.payout.id} ${event.data.data.payout.status} ${event.data.data.payout.amount} ${event.data.data.payout.currency} (minor units)`
          : `${event.data.data.transaction.id} ${event.data.data.transaction.amount} ${event.data.data.transaction.currency} (minor units)`;
      console.log(`${time}  ✓ ${type.padEnd(20)} ${summary}  ${id}${duplicate ? "  [duplicate, ignored]" : ""}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: true }));
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Webhook receiver on http://127.0.0.1:${port}/webhooks (verifying with ${secrets.length} secret(s))`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

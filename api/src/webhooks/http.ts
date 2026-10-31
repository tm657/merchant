import http from "node:http";
import https from "node:https";
import { BlockedTargetError, checkWebhookUrl, safeLookup, type TargetPolicy } from "./ssrf.js";

export type SendResult = { ok: boolean; status: number | null; error: string | null };

export type SendOptions = {
  url: string;
  body: string;
  headers: Record<string, string>;
  policy: TargetPolicy;
  /** Whole request, connect to last byte. */
  timeoutMs?: number;
  /** Stop reading the response after this many bytes. */
  maxResponseBytes?: number;
};

export type WebhookSender = (opts: SendOptions) => Promise<SendResult>;

/**
 * POSTs one webhook. Only a 2xx answer is a success. Never follows redirects, connects
 * only to vetted addresses (see safeLookup), gives up after `timeoutMs`, and reads at
 * most `maxResponseBytes` of the response before dropping the connection.
 */
export const sendWebhook: WebhookSender = ({ url: raw, body, headers, policy, timeoutMs = 5000, maxResponseBytes = 64 * 1024 }) =>
  new Promise((resolve) => {
    let url: URL;
    try {
      url = checkWebhookUrl(raw, policy);
    } catch (err) {
      resolve({ ok: false, status: null, error: (err as Error).message });
      return;
    }

    let settled = false;
    const finish = (result: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: safeLookup(policy),
      // A fresh connection each time: a pooled socket could point at an address vetted earlier.
      agent: false,
    });

    const deadline = setTimeout(() => {
      req.destroy(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      let received = 0;
      const done = () => {
        if (status >= 300 && status < 400) {
          finish({ ok: false, status, error: `redirects are not followed (got ${status})` });
        } else {
          finish({ ok: status >= 200 && status < 300, status, error: status >= 200 && status < 300 ? null : `HTTP ${status}` });
        }
      };
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        // We only need the status; don't let a huge or endless body tie us up.
        if (received > maxResponseBytes) {
          res.destroy();
          done();
        }
      });
      res.on("end", done);
      res.on("error", done);
    });

    req.on("error", (err) => {
      const message = err instanceof BlockedTargetError ? err.message : err.message || "request failed";
      finish({ ok: false, status: null, error: message });
    });

    req.end(body);
  });

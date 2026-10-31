// Content-Security-Policy, built per request in proxy.ts. No server-only imports.

/** 128 random bits, base64. A fresh one for every request. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy for HTML pages. Next.js reads the nonce from this header on the request and
 * puts it on every script and style it renders. That only works for pages rendered per
 * request, which is why the root layout opts the whole app into dynamic rendering.
 * Development adds what Next.js and React need there: eval (React's error stacks), inline
 * styles (dev style injection) and a websocket (hot reload).
 */
export function pageCsp(nonce: string, { dev, https }: { dev: boolean; https: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // The live event stream and every fetch are same-origin (the BFF).
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only over HTTPS: on plain-http hosts (local production builds, e2e) it would rewrite
    // every request to https and break the page.
    ...(https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/** JSON from the BFF is never a document: nothing may load or frame it. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

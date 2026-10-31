import dns from "node:dns";
import net, { type LookupFunction } from "node:net";

/** A webhook target we refuse to call. The message is safe to show the endpoint's owner. */
export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

// ---- Address ranges -----------------------------------------------------------

type Range = [base: bigint, prefix: number, bits: 32 | 128];

function v4ToBig(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** 16 bytes of an IPv6 address as a bigint. Handles '::', an embedded dotted IPv4 tail and zone ids. */
function v6ToBig(ip: string): bigint {
  let addr = ip.split("%")[0]!;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (tail) {
    const v4 = v4ToBig(tail[1]!);
    addr = `${addr.slice(0, -tail[1]!.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, rest] = addr.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

const v4 = (cidr: string): Range => {
  const [ip, prefix] = cidr.split("/") as [string, string];
  return [v4ToBig(ip), Number(prefix), 32];
};
const v6 = (cidr: string): Range => {
  const [ip, prefix] = cidr.split("/") as [string, string];
  return [v6ToBig(ip), Number(prefix), 128];
};

/**
 * Everything that isn't the public internet. "loopback" and "private" can be allowed for a
 * local demo (WEBHOOK_ALLOW_PRIVATE_TARGETS); "blocked" never can: that covers link-local,
 * where cloud metadata services live, plus multicast, reserved and documentation ranges.
 */
type Kind = "loopback" | "private" | "blocked";

const V4: [Range, Kind][] = (
  [
    ["0.0.0.0/8", "blocked"], // "this network"
    ["10.0.0.0/8", "private"],
    ["100.64.0.0/10", "private"], // carrier-grade NAT
    ["127.0.0.0/8", "loopback"],
    ["169.254.0.0/16", "blocked"], // link-local: cloud metadata (169.254.169.254)
    ["172.16.0.0/12", "private"],
    ["192.0.0.0/24", "blocked"], // IETF protocol assignments
    ["192.0.2.0/24", "blocked"], // documentation
    ["192.88.99.0/24", "blocked"], // 6to4 relay
    ["192.168.0.0/16", "private"],
    ["198.18.0.0/15", "blocked"], // benchmarking
    ["198.51.100.0/24", "blocked"], // documentation
    ["203.0.113.0/24", "blocked"], // documentation
    ["224.0.0.0/4", "blocked"], // multicast
    ["240.0.0.0/4", "blocked"], // reserved, includes 255.255.255.255
  ] as const
).map(([cidr, kind]) => [v4(cidr), kind]);

const V6: [Range, Kind][] = (
  [
    ["::/128", "blocked"], // unspecified
    ["::1/128", "loopback"],
    ["::/96", "blocked"], // IPv4-compatible (deprecated)
    ["64:ff9b:1::/48", "blocked"], // local-use NAT64
    ["100::/64", "blocked"], // discard
    ["2001::/32", "blocked"], // Teredo
    ["2001:db8::/32", "blocked"], // documentation
    ["fc00::/7", "private"], // unique local
    ["fe80::/10", "blocked"], // link-local
    ["fec0::/10", "blocked"], // site-local (deprecated)
    ["ff00::/8", "blocked"], // multicast
  ] as const
).map(([cidr, kind]) => [v6(cidr), kind]);

const inRange = (value: bigint, [base, prefix, bits]: Range) => {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
};

const MAPPED = v6("::ffff:0:0/96");
const NAT64 = v6("64:ff9b::/96");
const SIX_TO_FOUR = v6("2002::/16");

/** "public", or which non-public kind. Unparseable input counts as blocked. */
export function classifyAddress(ip: string): Kind | "public" {
  if (net.isIPv4(ip)) {
    const value = v4ToBig(ip);
    return V4.find(([r]) => inRange(value, r))?.[1] ?? "public";
  }
  if (!net.isIPv6(ip)) return "blocked";
  const value = v6ToBig(ip);
  // IPv6 forms that carry an IPv4 address are judged by that address.
  if (inRange(value, MAPPED) || inRange(value, NAT64)) return classifyAddress(bigToV4(value & 0xffffffffn));
  if (inRange(value, SIX_TO_FOUR)) return classifyAddress(bigToV4((value >> 80n) & 0xffffffffn));
  return V6.find(([r]) => inRange(value, r))?.[1] ?? "public";
}

/** True for any address a webhook must never reach under strict rules. */
export function isBlockedAddress(ip: string): boolean {
  return classifyAddress(ip) !== "public";
}

/** Whether `policy` lets a webhook reach `ip`. Link-local and reserved ranges never pass. */
export function isAllowedAddress(ip: string, policy: Pick<TargetPolicy, "allowPrivate">): boolean {
  const kind = classifyAddress(ip);
  return kind === "public" || (policy.allowPrivate && (kind === "loopback" || kind === "private"));
}

function bigToV4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => Number((value >> s) & 0xffn)).join(".");
}

// ---- URLs ---------------------------------------------------------------------------

export type TargetPolicy = {
  /** HTTPS only (production). */
  requireHttps: boolean;
  /** Allow loopback/private targets, for a local receiver in development. Never in production. */
  allowPrivate: boolean;
};

/** The bare host: URL keeps IPv6 literals in brackets. */
export const hostOf = (url: URL) => url.hostname.replace(/^\[(.*)\]$/, "$1");

/** Checks that need no network: scheme, credentials, and IP literals. Throws BlockedTargetError. */
export function checkWebhookUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !policy.requireHttps)) {
    throw new BlockedTargetError(policy.requireHttps ? "only https URLs are allowed" : "only http and https URLs are allowed");
  }
  if (url.username || url.password) throw new BlockedTargetError("URLs with credentials are not allowed");
  const host = hostOf(url);
  if (!host) throw new BlockedTargetError("the URL has no host");
  if (net.isIP(host) && !isAllowedAddress(host, policy)) {
    throw new BlockedTargetError(`${host} is a private, loopback, link-local or reserved address`);
  }
  return url;
}

type LookupAddress = { address: string; family: number };

function lookupAll(hostname: string, family: number): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, family }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

/**
 * Resolves a host and refuses it if ANY address is blocked (a hostname mixing public and
 * private records is treated as hostile). Returns the vetted addresses.
 */
export async function resolveTarget(hostname: string, policy: TargetPolicy, family = 0): Promise<LookupAddress[]> {
  if (net.isIP(hostname)) {
    if (!isAllowedAddress(hostname, policy)) throw new BlockedTargetError(`${hostname} is a blocked address`);
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookupAll(hostname, family);
  } catch {
    throw new BlockedTargetError(`could not resolve ${hostname}`);
  }
  if (addresses.length === 0) throw new BlockedTargetError(`could not resolve ${hostname}`);
  const bad = addresses.find((a) => !isAllowedAddress(a.address, policy));
  if (bad) {
    throw new BlockedTargetError(`${hostname} resolves to ${bad.address}, a private, loopback, link-local or reserved address`);
  }
  return addresses;
}

/** Full check before saving an endpoint: the URL rules plus a DNS resolution. */
export async function validateWebhookTarget(raw: string, policy: TargetPolicy): Promise<URL> {
  const url = checkWebhookUrl(raw, policy);
  await resolveTarget(hostOf(url), policy);
  return url;
}

/**
 * A `lookup` for http.request: the socket connects to exactly the address that was
 * vetted here, so DNS can't change between the check and the connection (rebinding).
 */
export function safeLookup(policy: TargetPolicy): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    resolveTarget(hostname, policy, typeof options.family === "number" ? options.family : 0).then(
      (addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: unknown) => callback(err),
    );
  }) as LookupFunction;
}

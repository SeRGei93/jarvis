/**
 * SSRF guard for the browser-free fetch layer.
 *
 * Goal: never let a user-supplied URL (or a server-controlled redirect) cause an
 * outbound request to a private / internal / metadata endpoint. We block known
 * non-public IP ranges and resolve hostnames up front so DNS-rebinding (a host
 * that resolves to a public address once and a private one later, or returns
 * mixed A/AAAA records) is rejected: if *any* resolved address is blocked, the
 * whole URL is rejected.
 *
 * Everything is injectable (`lookupFn`) so tests can simulate private IPs with
 * no real DNS.
 */
import { lookup } from "node:dns/promises";

import { webChild } from "./logger.js";

const log = webChild("ssrf");

/** Raised when a URL targets a disallowed (private/internal) destination or scheme. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** DNS resolver signature; mirrors `node:dns/promises` `lookup(host, { all: true })`. */
export type LookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Default resolver: real DNS via `node:dns/promises`.
 * `verbatim: true` keeps the OS ordering (no IPv4-first reshuffle), `all: true`
 * returns every A/AAAA record so we can inspect them all.
 */
export const defaultLookup: LookupFn = (hostname: string) =>
  lookup(hostname, { all: true, verbatim: true });

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

/**
 * Parses a dotted-quad IPv4 string into 4 octets, or null if it is not a
 * well-formed IPv4 literal (exactly four 0–255 decimal parts).
 */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject empty, non-numeric, leading-zero-padded oddities are tolerated but
    // value must be a plain decimal 0..255.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** True if the IPv4 octets fall in any non-public / dangerous range. */
function isBlockedIpv4(o: [number, number, number, number]): boolean {
  const [a, b] = o;

  // 0.0.0.0/8 — "this" network (incl. 0.0.0.0 unspecified)
  if (a === 0) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && o[2] === 0) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 255.255.255.255 — limited broadcast
  if (a === 255 && b === 255 && o[2] === 255 && o[3] === 255) return true;
  // 224.0.0.0/4 — multicast (224–239)
  if (a >= 224 && a <= 239) return true;

  return false;
}

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

/**
 * Expands an IPv6 string (possibly with `::` compression and/or an embedded
 * IPv4 tail) into 8 16-bit groups. Returns null if it cannot be parsed.
 */
function parseIpv6(ip: string): number[] | null {
  let str = ip.trim();
  // Drop a zone id (e.g. "fe80::1%eth0").
  const zone = str.indexOf("%");
  if (zone !== -1) str = str.slice(0, zone);

  // Handle an embedded IPv4 tail (e.g. "::ffff:192.0.2.1").
  let tailGroups: number[] = [];
  const lastColon = str.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : str.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    tailGroups = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    // Strip the IPv4 tail (and its leading colon); we add tailGroups manually below.
    // For "::ffff:192.0.2.1" this leaves "::ffff" so "::" compression is preserved.
    str = str.slice(0, lastColon);
  }

  const hasCompression = str.includes("::");
  let head: string[];
  let back: string[];

  if (hasCompression) {
    const [left, right, ...rest] = str.split("::");
    if (rest.length > 0) return null; // more than one "::" is invalid
    head = left ? left.split(":") : [];
    back = right ? right.split(":") : [];
  } else {
    head = str ? str.split(":") : [];
    back = [];
  }

  const hexGroups: number[] = [];
  for (const g of head) {
    if (g === "") continue;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    hexGroups.push(parseInt(g, 16));
  }
  const backGroups: number[] = [];
  for (const g of back) {
    if (g === "") continue;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    backGroups.push(parseInt(g, 16));
  }

  const explicit = hexGroups.length + backGroups.length + tailGroups.length;
  if (explicit > 8) return null;

  let groups: number[];
  if (hasCompression) {
    const fill = 8 - explicit;
    if (fill < 0) return null;
    groups = [
      ...hexGroups,
      ...new Array<number>(fill).fill(0),
      ...backGroups,
      ...tailGroups,
    ];
  } else {
    groups = [...hexGroups, ...tailGroups];
    if (groups.length !== 8) return null;
  }
  if (groups.length !== 8) return null;
  return groups;
}

/**
 * True if the IPv6 address is non-public. Handles IPv4-mapped addresses
 * (`::ffff:a.b.c.d`) by extracting the embedded IPv4 and re-checking it.
 */
function isBlockedIpv6(groups: number[]): boolean {
  const allZeroExceptLast = groups.slice(0, 7).every((g) => g === 0);

  // :: unspecified
  if (groups.every((g) => g === 0)) return true;
  // ::1 loopback
  if (allZeroExceptLast && groups[7] === 1) return true;

  // IPv4-mapped ::ffff:a.b.c.d — first 5 groups zero, 6th = 0xffff.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const a = (groups[6]! >> 8) & 0xff;
    const b = groups[6]! & 0xff;
    const c = (groups[7]! >> 8) & 0xff;
    const d = groups[7]! & 0xff;
    return isBlockedIpv4([a, b, c, d]);
  }

  const first = groups[0]!;
  // fc00::/7 — unique local addresses (high 7 bits = 1111110).
  if ((first & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local (high 10 bits = 1111111010).
  if ((first & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast.
  if ((first & 0xff00) === 0xff00) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Public address check
// ---------------------------------------------------------------------------

/**
 * Returns true if `ip` is a private / loopback / link-local / multicast / etc.
 * address that must never be the target of an outbound fetch.
 *
 * Conservative by design: if the string cannot be parsed as IPv4 or IPv6, it is
 * treated as BLOCKED.
 */
export function isBlockedAddress(ip: string): boolean {
  const trimmed = ip.trim();

  const v4 = parseIpv4(trimmed);
  if (v4) return isBlockedIpv4(v4);

  // IPv6 contains ":"; anything with a colon goes through the v6 parser.
  if (trimmed.includes(":")) {
    const v6 = parseIpv6(trimmed);
    if (!v6) return true; // unparseable → blocked
    return isBlockedIpv6(v6);
  }

  // Not parseable as either family → blocked.
  return true;
}

/** True if `host` looks like a bare IP literal (used to skip DNS resolution). */
function isIpLiteral(host: string): boolean {
  // Strip IPv6 brackets if present.
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return parseIpv4(inner) !== null || inner.includes(":");
}

/** Removes surrounding brackets from an IPv6 hostname literal. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Validates a URL for outbound fetching and returns the parsed `URL`.
 *
 * Steps:
 *  1. Parse and require an http:/https: scheme.
 *  2. If the host is an IP literal, check it directly.
 *  3. Otherwise resolve every A/AAAA record and reject if ANY is non-public
 *     (anti DNS-rebinding) or if resolution yields nothing.
 *
 * @throws {SsrfError} when the URL is malformed, non-http(s), or resolves to a
 *   blocked address.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`Disallowed URL scheme: ${parsed.protocol}`);
  }

  const host = parsed.hostname;

  // 1) Direct IP literal — no DNS needed.
  if (isIpLiteral(host)) {
    const ip = stripBrackets(host);
    if (isBlockedAddress(ip)) {
      log.warn({ host: ip }, "ssrf: blocked IP literal");
      throw new SsrfError(`Blocked IP literal: ${ip}`);
    }
    return parsed;
  }

  // 2) Resolve hostname and inspect every returned address.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookupFn(host);
  } catch (err) {
    log.warn({ host, err: (err as Error).message }, "ssrf: DNS lookup failed");
    throw new SsrfError(`DNS lookup failed for ${host}`);
  }

  if (!addrs || addrs.length === 0) {
    log.warn({ host }, "ssrf: no addresses resolved");
    throw new SsrfError(`No addresses resolved for ${host}`);
  }

  for (const { address } of addrs) {
    if (isBlockedAddress(address)) {
      log.warn({ host, address }, "ssrf: resolved to blocked address");
      throw new SsrfError(`${host} resolves to a blocked address: ${address}`);
    }
  }

  log.debug({ host, count: addrs.length }, "ssrf: url allowed");
  return parsed;
}

import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.ts';

/**
 * Printers live on the local network. Restricting printer addresses to
 * private / loopback / link-local ranges stops the app from being used to
 * probe arbitrary internet hosts (SSRF), unless ALLOW_PUBLIC_PRINTER_HOSTS
 * lifts the restriction.
 */

const blockList = new net.BlockList();
// Private / local ranges are added to a list we then use as an *allow* list.
for (const [addr, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10], // CGNAT / Tailscale
] as const) {
  blockList.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['fc00::', 7],
  ['fe80::', 10],
  ['::1', 128],
] as const) {
  blockList.addSubnet(addr, prefix, 'ipv6');
}

export function isLocalAddress(ip: string) {
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return family !== null && blockList.check(ip, family);
}

/** Returns an error message, or null when the host is acceptable. */
export async function checkPrinterHost(host: string): Promise<string | null> {
  if (config.allowPublicPrinterHosts) return null;
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return `Could not resolve "${host}"`;
    }
  }
  const nonLocal = addresses.filter((a) => !isLocalAddress(a));
  return nonLocal.length
    ? `"${host}" is not a local network address (${nonLocal.join(', ')}). Printers must be on the LAN.`
    : null;
}

/**
 * Push endpoints are the opposite case: the browser hands us a URL and the
 * server POSTs to it, so it must point at a public push service — never at
 * the LAN, loopback or a reserved range (SSRF).
 */
const reservedV4 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  reservedV4.addSubnet(addr, prefix, 'ipv4');
}
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const reservedV6 = new net.BlockList();
for (const [addr, prefix] of [
  ['2001::', 23], // IETF protocol assignments (Teredo, ...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds arbitrary IPv4 addresses)
] as const) {
  reservedV6.addSubnet(addr, prefix, 'ipv6');
}

export function isPublicAddress(ip: string) {
  if (net.isIPv4(ip)) return !isLocalAddress(ip) && !reservedV4.check(ip, 'ipv4');
  // Only global unicast; this also excludes IPv4-mapped/NAT64 forms of local addresses.
  if (net.isIPv6(ip)) return globalV6.check(ip, 'ipv6') && !reservedV6.check(ip, 'ipv6');
  return false;
}

/** DNS resolution used by the push endpoint check (replaceable in tests). */
export const pushResolver = {
  lookup: async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true })).map((a) => a.address),
};

export const MAX_PUSH_ENDPOINT_LENGTH = 1024;

/** Returns an error message, or null when the push endpoint is acceptable. */
export async function checkPushEndpoint(endpoint: string): Promise<string | null> {
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return 'Push endpoint is too long';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'Push endpoint is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'Push endpoint must use https';
  if (url.username || url.password) return 'Push endpoint must not contain credentials';
  if (url.port) return 'Push endpoint must use the default https port';
  const host = url.hostname;
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return 'Push endpoint must use a host name';
  let addresses: string[];
  try {
    addresses = await pushResolver.lookup(host);
  } catch {
    return `Could not resolve the push service "${host}"`;
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) {
    return `Push service "${host}" does not resolve to a public address`;
  }
  return null;
}

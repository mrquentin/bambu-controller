import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Printers live on the local network. Restricting printer addresses to
 * private / loopback / link-local ranges stops the app from being used to
 * probe arbitrary internet hosts (SSRF). Set ALLOW_PUBLIC_PRINTER_HOSTS=true
 * to lift the restriction (e.g. printers reached through a routed VPN).
 */
const allowPublic = process.env.ALLOW_PUBLIC_PRINTER_HOSTS === 'true';

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
  if (allowPublic) return null;
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

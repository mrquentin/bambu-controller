import dgram from 'node:dgram';
import type { DiscoveredPrinter as Discovered } from '../../shared/api.ts';
import { modelFromCode } from './models.ts';

export type DiscoveredPrinter = Omit<Discovered, 'alreadyAdded'>;

/**
 * Bambu printers announce themselves with SSDP-style NOTIFY packets broadcast
 * to UDP 2021 (and 1990), and answer M-SEARCH sent to 239.255.255.250:1990.
 * Headers of interest: Location (IP), USN (serial), DevName.bambu.com,
 * DevModel.bambu.com, DevConnect.bambu.com (lan/cloud), DevSignal.bambu.com.
 */
export function parseSsdp(message: string, fallbackIp: string): DiscoveredPrinter | null {
  if (!/bambu/i.test(message)) return null;
  const headers = new Map<string, string>();
  for (const line of message.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  const serial = headers.get('usn');
  if (!serial) return null;
  const modelCode = headers.get('devmodel.bambu.com') ?? '';
  return {
    serial,
    ip: headers.get('location')?.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') || fallbackIp,
    name: headers.get('devname.bambu.com') ?? serial,
    modelCode,
    model: modelFromCode(modelCode),
    connectMode: headers.get('devconnect.bambu.com') ?? null,
    signal: headers.get('devsignal.bambu.com') ?? null,
  };
}

function bindSocket(port: number): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.once('error', () => {
      socket.close();
      resolve(null);
    });
    socket.bind(port, () => resolve(socket));
  });
}

export async function discoverPrinters(durationMs = 6_000): Promise<DiscoveredPrinter[]> {
  const found = new Map<string, DiscoveredPrinter>();
  // Printers announce on 2021/1990 (either may be taken by another app); the ephemeral socket asks.
  const [notify2021, notify1990, searcher] = await Promise.all([bindSocket(2021), bindSocket(1990), bindSocket(0)]);
  const sockets = [notify2021, notify1990, searcher].filter((s): s is dgram.Socket => s !== null);

  for (const socket of sockets) {
    socket.on('message', (msg, rinfo) => {
      const printer = parseSsdp(msg.toString('utf8'), rinfo.address);
      if (printer) found.set(printer.serial, printer);
    });
    try {
      socket.setBroadcast(true);
    } catch {}
  }

  if (searcher) {
    const probe = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nMan: "ssdp:discover"\r\nST: ssdp:all\r\nMX: 3\r\n\r\n',
    );
    const send = () => {
      searcher.send(probe, 1990, '239.255.255.250', () => {});
      searcher.send(probe, 2021, '255.255.255.255', () => {});
    };
    send();
    setTimeout(send, 1_500);
  }

  await new Promise((r) => setTimeout(r, durationMs));
  for (const socket of sockets) socket.close();
  return [...found.values()];
}

/**
 * Is this app's server reachable from the browser? (Not to be confused with a
 * printer being offline: that is the printer's connection, see ConnectionBadge.)
 *
 * api() and the live event streams report what they see; while the server is
 * unreachable a light health probe retries until it answers again.
 */
const PROBE_MS = 5_000;

export const connectivity = $state({
  /** navigator.onLine: false means the device has no network at all. */
  browserOnline: navigator.onLine,
  /** False after a request failed at the network level (or a gateway error). */
  serverReachable: true,
});

let probeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleProbe(delay = PROBE_MS) {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(probe, delay);
}

async function probe() {
  probeTimer = null;
  try {
    const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
    if (isGatewayError(res.status)) throw new Error(res.statusText);
    reportServerReachable();
  } catch {
    scheduleProbe();
  }
}

/** A reverse proxy answering for a server that is down. */
export const isGatewayError = (status: number) => status === 502 || status === 503 || status === 504;

export function reportServerUnreachable() {
  if (connectivity.serverReachable) connectivity.serverReachable = false;
  if (!probeTimer) scheduleProbe();
}

export function reportServerReachable() {
  if (!connectivity.serverReachable) connectivity.serverReachable = true;
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

window.addEventListener('offline', () => {
  connectivity.browserOnline = false;
});
window.addEventListener('online', () => {
  connectivity.browserOnline = true;
  // Check right away instead of waiting for the next probe.
  if (!connectivity.serverReachable) scheduleProbe(0);
});

/** Browser side of push notifications (see web/public/sw.js and server/push.ts). */

/**
 * Why push can't work here, or null when it can. Order matters: an insecure
 * context hides the APIs entirely, so check it before feature detection.
 */
export function pushBlocker(): 'insecure' | 'ios-not-installed' | 'unsupported' | null {
  if (!window.isSecureContext) return 'insecure';
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (supported) return null;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  return ios && !standalone ? 'ios-not-installed' : 'unsupported';
}

/** Register the worker (network-only, push handling) and follow notification clicks. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'navigate' || typeof event.data.url !== 'string') return;
    const url = new URL(event.data.url, location.origin);
    if (url.origin === location.origin) location.hash = url.hash;
  });
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** SHA-256 of the endpoint, hex: matches the server's `fingerprint` for this device. */
export async function endpointFingerprint(endpoint: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function swRegistration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }));
}

/** This browser's subscription for `publicKey`, creating it (or replacing one made with an older key). */
export async function subscribe(publicKey: string): Promise<PushSubscription> {
  await swRegistration();
  const reg = await navigator.serviceWorker.ready;
  const key = base64UrlToBytes(publicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    const current = existing.options.applicationServerKey;
    if (current && sameBytes(new Uint8Array(current), key)) return existing;
    await existing.unsubscribe();
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

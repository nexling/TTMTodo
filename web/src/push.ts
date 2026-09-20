import { api } from "./api";

type NavStandalone = Navigator & { standalone?: boolean };

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as NavStandalone;
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function isAndroidDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function keysMatch(stored: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!stored) return false;
  const view = new Uint8Array(stored);
  if (view.length !== expected.length) return false;
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== expected[i]) return false;
  }
  return true;
}

export async function hasPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub != null;
}

export async function subscribePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (Notification.permission !== "granted") return false;
  const { publicKey } = await api.pushVapid();
  const expected = urlBase64ToUint8Array(publicKey);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !keysMatch(sub.options.applicationServerKey, expected)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: expected as BufferSource,
    });
  }
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("Push subscription incomplete");
  }
  await api.pushSubscribe({ endpoint: json.endpoint, keys: { p256dh, auth } });
  return true;
}

export async function unsubscribePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try {
    await api.pushUnsubscribe(endpoint);
  } catch {
    /* already gone on the server */
  }
}

export async function showLocalNotification(title: string, body: string, url = "/"): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(title, {
    body,
    icon: "/pwa-192.png",
    badge: "/pwa-192.png",
    vibrate: [200, 100, 200],
    data: { url },
  } as NotificationOptions);
}

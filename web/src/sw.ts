/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/(api|share-target|login|callback|logout)(\/|$|\?)/],
  }),
);

type PushPayload = {
  title?: string;
  body?: string;
  url?: string;
};

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function showPushNotification(title: string, body: string, url: string): Promise<void> {
  await self.registration.showNotification(title, {
    body,
    icon: "/pwa-192.png",
    badge: "/pwa-192.png",
    vibrate: [200, 100, 200],
    data: { url },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "TTM-Todo";
      let body = "Reminder";
      let url = "/";
      try {
        const data = (event.data ? event.data.json() : {}) as PushPayload;
        if (data.title) title = data.title;
        if (data.body) body = data.body;
        if (data.url) url = data.url;
      } catch {
        /* ignore */
      }
      await showPushNotification(title, body, url);
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const vapid = await fetch("/api/push/vapid", { credentials: "same-origin" });
        if (!vapid.ok) return;
        const { publicKey } = (await vapid.json()) as { publicKey?: string };
        if (!publicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
        const json = sub.toJSON();
        const p256dh = json.keys?.p256dh;
        const auth = json.keys?.auth;
        if (!json.endpoint || !p256dh || !auth) return;
        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh, auth } }),
        });
      } catch {
        /* signed out or push unavailable */
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        await client.focus();
        if ("navigate" in client) {
          try {
            await client.navigate(target);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

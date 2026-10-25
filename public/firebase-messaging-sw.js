// Shows family chat push notifications. Registered by index.html when someone
// turns notifications on; index.html also passes this registration to FCM's
// getToken, so FCM pushes arrive here.
//
// We show every push ourselves instead of loading the Firebase messaging SDK:
// the SDK skips the notification whenever a chat window is visible, and iOS
// revokes push permission from sites that receive pushes without showing one.
// The open chat page clears these notifications once it's being looked at.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json().data || {};
  } catch {}
  event.waitUntil(self.registration.showNotification(data.title || "Vaschuk Family", {
    body: data.body || "New message",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.id || undefined,
  }));
});

// Focus an open chat window, or open one, on this worker's origin.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) return open.focus();
    return clients.openWindow("/");
  })());
});

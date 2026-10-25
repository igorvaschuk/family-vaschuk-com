// Shows family chat push notifications while the site is closed or in the
// background. Registered by index.html when someone turns notifications on.

// Registered before the Firebase SDK so it wins: focus an open chat window,
// or open one, on whichever origin this worker belongs to.
self.addEventListener("notificationclick", (event) => {
  event.stopImmediatePropagation();
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) return open.focus();
    return clients.openWindow("/");
  })());
});

importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyC1XotJSjFhLQQo3i8KNO7xpLHeO8URHOY",
  authDomain: "vaschuk-com.firebaseapp.com",
  projectId: "vaschuk-com",
  appId: "1:1059072294008:web:8272aff3b02d2d7129818d",
  messagingSenderId: "1059072294008",
});

// Messages carry a webpush `notification` payload, which the SDK displays
// on its own whenever no chat window is visible.
firebase.messaging();

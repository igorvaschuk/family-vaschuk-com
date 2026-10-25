// Pushes each new family chat message to every opted-in device except the
// sender's. Devices register in tokens/{token} (see public/index.html).
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// FCM errors that mean the token will never work again.
const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

exports.notifyFamily = onDocumentCreated(
  { document: "messages/{id}", region: "us-central1" },
  async (event) => {
    const msg = event.data?.data();
    if (!msg) return;

    const db = getFirestore();
    const snap = await db.collection("tokens").get();
    const tokens = snap.docs.filter((d) => d.get("uid") !== msg.uid).map((d) => d.id);
    if (!tokens.length) return;

    const body = msg.text.length > 180 ? msg.text.slice(0, 179) + "…" : msg.text;
    const dead = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const res = await getMessaging().sendEachForMulticast({
        tokens: batch,
        webpush: {
          notification: { title: msg.name, body, icon: "/icon-192.png", badge: "/icon-192.png" },
          headers: { Urgency: "high", TTL: "86400" },
        },
      });
      res.responses.forEach((r, j) => {
        if (!r.success && DEAD_TOKEN.has(r.error?.code)) dead.push(batch[j]);
      });
      logger.info(`message ${event.params.id}: sent ${res.successCount}/${batch.length}`);
    }
    await Promise.all(dead.map((t) => db.collection("tokens").doc(t).delete()));
  },
);

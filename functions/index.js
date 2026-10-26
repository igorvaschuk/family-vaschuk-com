// Cloud Functions for family.vaschuk.com (codebase "family", us-central1):
//  - notifyFamily: pushes each new family-chat message to every opted-in
//    device except the sender's. Devices register in tokens/{token}.
//  - familyAssistant: answers requests to the assistant ("/..." in the family
//    chat, or anything in the assistant tab) using Claude with tools for the
//    family calendar, places and memory (see assistant.js).
//  - privateAssistant: the same assistant in each member's private thread
//    (users/{uid}/thread), with that member's private memory.
//  - familyReminders: every 5 minutes, pushes "time to leave" reminders to
//    every device at driving time + 10 min before activities (reminders.js).
//  - gcal*: copies the family calendar into each member's Google Calendar
//    once they connect it (gcal-functions.js).
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { ASSISTANT, requestText, runRequest, nominatimGeocode } from "./assistant.js";
import { dueReminders, drivingMinutes } from "./reminders.js";
import { FAMILY_TZ } from "./recurrence.js";

initializeApp();

export { gcal, gcalSync, gcalPushEvent, gcalPushPlace, gcalNightly, gcalImport } from "./gcal-functions.js";
import { GCAL_SECRETS, importAccess } from "./gcal-functions.js";
import { firestoreStore } from "./store.js";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
// Override with functions/.env (not committed) if needed.
const MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";
let webSearch = process.env.ASSISTANT_WEB_SEARCH !== "off";

// FCM errors that mean the token will never work again.
const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

export const notifyFamily = onDocumentCreated(
  { document: "messages/{id}", region: "us-central1" },
  async (event) => {
    const msg = event.data?.data();
    // The assistant tab is a working space; only the family chat pushes.
    if (!msg || msg.channel === "assistant") return;

    const db = getFirestore();
    const snap = await db.collection("tokens").get();
    const tokens = snap.docs.filter((d) => d.get("uid") !== msg.uid).map((d) => d.id);
    if (!tokens.length) return;

    const title = msg.uid === ASSISTANT.uid ? "✨ " + ASSISTANT.name : msg.name;
    const body = msg.text.length > 180 ? msg.text.slice(0, 179) + "…" : msg.text;
    const dead = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const res = await getMessaging().sendEachForMulticast({
        tokens: batch,
        // Data-only: public/firebase-messaging-sw.js builds the notification.
        webpush: {
          data: { title, body, id: event.params.id },
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

/** Pushes data-only notifications to every registered device. */
async function pushAll(db, data) {
  const snap = await db.collection("tokens").get();
  const tokens = snap.docs.map((d) => d.id);
  const dead = [];
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast({
      tokens: batch,
      webpush: { data, headers: { Urgency: "high", TTL: "1800" } },
    });
    sent += res.successCount;
    res.responses.forEach((r, j) => {
      if (!r.success && DEAD_TOKEN.has(r.error?.code)) dead.push(batch[j]);
    });
  }
  await Promise.all(dead.map((t) => db.collection("tokens").doc(t).delete()));
  return sent;
}

export const familyReminders = onSchedule(
  { schedule: "every 5 minutes", region: "us-central1", timeZone: FAMILY_TZ },
  async () => {
    const db = getFirestore();
    const [events, places] = await Promise.all(["events", "places"].map(async (c) =>
      (await db.collection(c).get()).docs.map((d) => ({ id: d.id, ...d.data() }))));
    const due = dueReminders({ events, places });
    for (const r of due) {
      // create() fails if the doc exists, so each occurrence is sent once
      // even if two runs overlap.
      try {
        await db.collection("reminders").doc(r.key).create({ eventId: r.eventId, date: r.date, title: r.title, sentAt: FieldValue.serverTimestamp() });
      } catch {
        continue;
      }
      const n = await pushAll(db, { title: r.title, body: r.body, id: "leave-" + r.key, url: r.url });
      logger.info(`reminder ${r.key}: sent to ${n} device(s)`);
    }
  },
);

async function callClaude({ system, messages, tools }) {
  const body = {
    model: MODEL,
    max_tokens: 2048,
    system,
    messages,
    tools: webSearch
      ? [...tools, { type: "web_search_20250305", name: "web_search", max_uses: 3, user_location: { type: "approximate", country: "US", timezone: FAMILY_TZ } }]
      : tools,
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    // Web search must be enabled for the API organization; work without it if not.
    if (webSearch && res.status === 400 && /web_search/i.test(detail)) {
      logger.warn("web search unavailable, continuing without it", detail.slice(0, 300));
      webSearch = false;
      return callClaude({ system, messages, tools });
    }
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 500)}`);
  }
  return res.json();
}

const ASSISTANT_OPTS = { region: "us-central1", secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: "512MiB" };

export const familyAssistant = onDocumentCreated(
  { document: "messages/{id}", ...ASSISTANT_OPTS },
  (event) => answer(event, "messages"),
);

export const privateAssistant = onDocumentCreated(
  { document: "users/{uid}/thread/{id}", ...ASSISTANT_OPTS, secrets: [ANTHROPIC_API_KEY, ...GCAL_SECRETS] },
  async (event) => {
    const msg = event.data?.data();
    // The rules only let the owner write here; double-check before acting for them.
    if (!msg || msg.uid !== event.params.uid || msg.channel !== "private") return;
    await answer(event, `users/${event.params.uid}/thread`);
  },
);

/** Answers a request posted in `coll` with a reply in the same collection. */
async function answer(event, coll) {
  const msg = event.data?.data();
  const request = requestText(msg);
  if (request == null) return;

  const db = getFirestore();
  const reqRef = event.data.ref;
  const channel = ["assistant", "private"].includes(msg.channel) ? msg.channel : "family";
  const post = (data, to = coll) => db.collection(to).add({
    uid: ASSISTANT.uid, name: ASSISTANT.name, photo: "", channel,
    replyTo: event.params.id, requester: { uid: msg.uid, name: msg.name },
    createdAt: FieldValue.serverTimestamp(), ...data,
  });

  await reqRef.update({ status: "thinking" });
  try {
    const out = await runRequest({
      store: firestoreStore(db),
      // A member's own Google Calendar, for bringing events in (private thread only).
      gcal: channel === "private" ? await importAccess(msg.uid) : null,
      callClaude,
      geocode: (q) => nominatimGeocode(q),
      route: (a, b) => drivingMinutes(a, b),
      request,
      msgId: event.params.id,
      msg,
      log: (...a) => logger.warn(...a),
    });
    const reply = await post({
      kind: "reply",
      text: out.text.slice(0, 4000),
      refs: out.refs,
      links: out.links,
      changes: out.changes,
    });
    if (out.familyNotice) await post({ kind: "notice", channel: "family", text: out.familyNotice.slice(0, 1000) }, "messages");
    await reqRef.update({ status: "done", replyId: reply.id });
    logger.info(`request ${event.params.id} by ${msg.name}: ${out.changes.length} change(s)`);
  } catch (e) {
    logger.error(`request ${event.params.id} failed`, e);
    await post({ kind: "error", text: "Sorry, something went wrong on my side. Please check the calendar and try again in a minute." });
    await reqRef.update({ status: "error" });
  }
}

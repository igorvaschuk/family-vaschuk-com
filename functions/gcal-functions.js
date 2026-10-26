// Cloud Functions for Google Calendar sync (re-exported by index.js):
//  - gcal: HTTPS endpoint behind the site at /gcal/* (firebase.json rewrite):
//      POST /gcal/start       → { url } to Google's consent screen
//      GET  /gcal/callback    ← Google redirects here; stores the link, creates
//                               the "Vaschuk Family" calendar, starts a full sync
//      POST /gcal/disconnect  → deletes that calendar and forgets the link
//      POST /gcal/resync      → copies everything again
//    POSTs need the member's Firebase ID token (Authorization: Bearer ...).
//  - gcalPushEvent / gcalPushPlace: copy each family calendar change (or a
//    renamed/moved place) to every linked Google calendar.
//  - gcalSync: full sync of one account when gcalAccounts/{uid}.resyncRequestedAt
//    changes (after connecting, on request, and nightly from gcalNightly).
//  - gcalImport: every 30 minutes, for members who let the site read their
//    calendars: imported events follow their Google Calendar, rules handle new
//    events, and once a day the private assistant asks about the rest
//    (gcal-import.js).
//
// Firestore:
//   gcalAccounts/{uid}       refresh token, Google email, calendar id: no client access
//   gcalStates/{nonce}       pending consent screens (10 minutes): no client access
//   users/{uid}/settings/gcal  status the member's page shows (read-only for them)
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { randomBytes } from "node:crypto";
import { getMessaging } from "firebase-admin/messaging";
import { CALENDAR_NAME, oauthClient, calendarApi, syncAll, pushOne, isRevoked, canImport } from "./gcal.js";
import { importer, digestText } from "./gcal-import.js";
import { firestoreStore } from "./store.js";
import { FAMILY_TZ, familyNow } from "./recurrence.js";

// OAuth client (Web application) from Google Cloud console → Google Auth Platform → Clients.
const GCAL_CLIENT_ID = defineSecret("GCAL_CLIENT_ID");
const GCAL_CLIENT_SECRET = defineSecret("GCAL_CLIENT_SECRET");
const SECRETS = [GCAL_CLIENT_ID, GCAL_CLIENT_SECRET];
export const GCAL_SECRETS = SECRETS;

const PROJECT = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
const APP_URLS = { "vaschuk-com": "https://family.vaschuk.com", "family-dev-vaschuk-com": "https://family-dev.vaschuk.com" };
const APP_URL = process.env.APP_URL || APP_URLS[PROJECT] || `https://${PROJECT}.web.app`;
// Must be listed under the OAuth client's "Authorized redirect URIs".
const REDIRECT_URI = `${APP_URL}/gcal/callback`;
const STATE_TTL_MS = 10 * 60 * 1000;

const oauth = () => oauthClient({ clientId: GCAL_CLIENT_ID.value(), clientSecret: GCAL_CLIENT_SECRET.value() });
const accountRef = (uid) => getFirestore().collection("gcalAccounts").doc(uid);
const statusRef = (uid) => getFirestore().doc(`users/${uid}/settings/gcal`);
const setStatus = (uid, data) => statusRef(uid).set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

/** The family member behind a request's ID token, or null. */
async function memberOf(req) {
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!m) return null;
  let t;
  try {
    t = await getAuth().verifyIdToken(m[1]);
  } catch {
    return null;
  }
  if (!t.email_verified) return null;
  const emails = (await getFirestore().doc("config/members").get()).get("emails") || [];
  return emails.includes(String(t.email).toLowerCase()) ? t : null;
}

/** A working Calendar API client for a linked account; marks the link broken if Google revoked it. */
async function apiFor(uid, account) {
  try {
    const { accessToken } = await oauth().refresh(account.refreshToken);
    return calendarApi(accessToken);
  } catch (e) {
    if (isRevoked(e)) await markRevoked(uid);
    throw e;
  }
}

async function markRevoked(uid) {
  logger.warn(`gcal ${uid}: access revoked, waiting for reconnect`);
  await accountRef(uid).update({ revoked: true }).catch(() => {});
  await setStatus(uid, { state: "error", error: "Google stopped letting the family site update your calendar. Reconnect to keep it in sync." });
}

async function linkedAccounts() {
  const snap = await getFirestore().collection("gcalAccounts").get();
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((a) => a.calendarId && a.refreshToken && !a.revoked);
}

const back = (res, result) => res.redirect(303, `${APP_URL}/?gcal=${result}#assistant/me`);

export const gcal = onRequest({ region: "us-central1", secrets: SECRETS, timeoutSeconds: 60 }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const action = req.path.replace(/^\/gcal/, "").replace(/^\/+|\/+$/g, "");
  try {
    if (action === "callback" && req.method === "GET") return await callback(req, res);
    if (req.method !== "POST") return void res.status(405).json({ error: "method not allowed" });
    const member = await memberOf(req);
    if (!member) return void res.status(403).json({ error: "family members only" });

    if (action === "start") {
      const nonce = randomBytes(18).toString("hex");
      await getFirestore().collection("gcalStates").doc(nonce).set({ uid: member.uid, expiresAt: Date.now() + STATE_TTL_MS });
      // { import: true }: also ask to read their calendars, to bring events in.
      return void res.json({ url: oauth().authUrl({ redirectUri: REDIRECT_URI, state: nonce, loginHint: member.email, withImport: !!req.body?.import }) });
    }
    if (action === "resync") {
      const snap = await accountRef(member.uid).get();
      if (!snap.exists) return void res.status(404).json({ error: "not connected" });
      await snap.ref.update({ resyncRequestedAt: FieldValue.serverTimestamp() });
      return void res.json({ ok: true });
    }
    if (action === "disconnect") {
      const snap = await accountRef(member.uid).get();
      const account = snap.data();
      if (account?.refreshToken) {
        // The calendar is the app's own copy; take it out of their Google Calendar too.
        try {
          if (account.calendarId && !account.revoked) await (await apiFor(member.uid, account)).deleteCalendar(account.calendarId);
        } catch (e) {
          logger.warn(`gcal ${member.uid}: couldn't delete calendar`, e.message);
        }
        await oauth().revoke(account.refreshToken);
      }
      await snap.ref.delete();
      await statusRef(member.uid).set({ state: "off", updatedAt: FieldValue.serverTimestamp() });
      return void res.json({ ok: true });
    }
    res.status(404).json({ error: "unknown action" });
  } catch (e) {
    logger.error(`gcal ${action} failed`, e);
    if (action === "callback") return back(res, "error");
    res.status(500).json({ error: "something went wrong" });
  }
});

async function callback(req, res) {
  const { code, state, error } = req.query;
  if (!state) return back(res, "error");
  const db = getFirestore();
  const stateRef = db.collection("gcalStates").doc(String(state));
  // One use per consent screen.
  const pending = await db.runTransaction(async (tx) => {
    const s = await tx.get(stateRef);
    if (s.exists) tx.delete(stateRef);
    return s.exists ? s.data() : null;
  });
  if (!pending || pending.expiresAt < Date.now()) return back(res, "expired");
  if (error || !code) return back(res, "denied");

  const { uid } = pending;
  const t = await oauth().exchange(String(code), REDIRECT_URI);
  if (!t.refreshToken) throw new Error("Google sent no refresh token");
  if (!t.scope.includes("calendar.app.created")) return back(res, "denied");

  // Reuse the calendar from an earlier link if it still exists.
  const api = calendarApi(t.accessToken);
  const old = (await accountRef(uid).get()).data();
  let calendarId = old?.calendarId && old.email === t.email && (await api.getCalendar(old.calendarId)) ? old.calendarId : null;
  if (!calendarId) calendarId = (await api.createCalendar()).id;

  await accountRef(uid).set({
    refreshToken: t.refreshToken,
    email: t.email,
    calendarId,
    scope: t.scope,
    revoked: false,
    connectedAt: FieldValue.serverTimestamp(),
    resyncRequestedAt: FieldValue.serverTimestamp(),
  });
  await setStatus(uid, { state: "syncing", email: t.email, calendarName: CALENDAR_NAME, canImport: canImport(t.scope), error: null, connectedAt: FieldValue.serverTimestamp() });
  logger.info(`gcal ${uid}: connected ${t.email}`);
  back(res, "connected");
}

/** Full sync of one account whenever a resync is requested. */
export const gcalSync = onDocumentWritten(
  { document: "gcalAccounts/{uid}", region: "us-central1", secrets: SECRETS, timeoutSeconds: 540 },
  async (event) => {
    const before = event.data?.before?.data();
    const account = event.data?.after?.data();
    if (!account?.calendarId || account.revoked) return;
    if (before && before.resyncRequestedAt?.isEqual?.(account.resyncRequestedAt)) return;
    const uid = event.params.uid;
    const db = getFirestore();
    try {
      const api = await apiFor(uid, account);
      if (!(await api.getCalendar(account.calendarId))) {
        // They deleted the calendar in Google; make a new one.
        const { id } = await api.createCalendar();
        account.calendarId = id;
        await event.data.after.ref.update({ calendarId: id });
      }
      const [events, places] = await Promise.all(["events", "places"].map(async (c) =>
        (await db.collection(c).get()).docs.map((d) => ({ id: d.id, ...d.data() }))));
      // Events imported from this member's own calendar are already there.
      const out = await syncAll({ api, calendarId: account.calendarId, events: events.filter((e) => e.source?.uid !== uid), places, appUrl: APP_URL });
      logger.info(`gcal ${uid}: synced ${out.pushed}, removed ${out.removed}, failed ${out.failed.length}`, out.failed);
      await setStatus(uid, {
        state: "connected",
        events: out.pushed,
        error: out.failed.length ? `Couldn't copy: ${out.failed.map((f) => f.title).join(", ").slice(0, 300)}` : null,
        lastSyncAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if (isRevoked(e)) return;
      logger.error(`gcal ${uid}: sync failed`, e);
      await setStatus(uid, { state: "error", error: "Couldn't copy the family calendar to Google. It will try again tonight, or tap Sync now." });
    }
  },
);

/** Copies one family event change to every linked Google calendar. */
async function pushToAll(ids) {
  const accounts = await linkedAccounts();
  if (!accounts.length || !ids.length) return;
  const db = getFirestore();
  // Read the current state rather than trusting the trigger payload, so
  // out-of-order deliveries still end with Google matching Firestore.
  const events = await Promise.all(ids.map(async (id) => {
    const snap = await db.collection("events").doc(id).get();
    return { id, ev: snap.exists ? snap.data() : null };
  }));
  const placeIds = [...new Set(events.map((e) => e.ev?.placeId).filter(Boolean))];
  const places = new Map(await Promise.all(placeIds.map(async (id) => [id, (await db.collection("places").doc(id).get()).data()])));
  for (const account of accounts) {
    try {
      const api = await apiFor(account.uid, account);
      for (const { id, ev } of events) {
        // Not back into the calendar it was imported from.
        const own = ev?.source?.uid === account.uid;
        await pushOne({ api, calendarId: account.calendarId, id, ev: own ? null : ev, place: ev?.placeId && places.get(ev.placeId), appUrl: APP_URL });
      }
      await setStatus(account.uid, { lastSyncAt: FieldValue.serverTimestamp() });
    } catch (e) {
      if (isRevoked(e)) continue;
      logger.error(`gcal ${account.uid}: push of ${ids.join(",")} failed`, e);
      if (e.status === 404) await accountRef(account.uid).update({ resyncRequestedAt: FieldValue.serverTimestamp() });
    }
  }
}

export const gcalPushEvent = onDocumentWritten(
  { document: "events/{id}", region: "us-central1", secrets: SECRETS, timeoutSeconds: 120 },
  (event) => pushToAll([event.params.id]),
);

/** A place's name or address shows in its events' Google location, so re-push them. */
export const gcalPushPlace = onDocumentWritten(
  { document: "places/{id}", region: "us-central1", secrets: SECRETS, timeoutSeconds: 300 },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (before && after && before.name === after.name && before.address === after.address) return;
    const snap = await getFirestore().collection("events").where("placeId", "==", event.params.id).get();
    await pushToAll(snap.docs.map((d) => d.id));
  },
);

/** Nightly full sync for every linked account, to repair anything a push missed. */
export const gcalNightly = onSchedule(
  { schedule: "every day 03:30", region: "us-central1", timeZone: FAMILY_TZ },
  async () => {
    const db = getFirestore();
    for (const a of await linkedAccounts()) await db.collection("gcalAccounts").doc(a.uid).update({ resyncRequestedAt: FieldValue.serverTimestamp() });
    // Drop consent screens that were never finished.
    const stale = await db.collection("gcalStates").where("expiresAt", "<", Date.now()).get();
    await Promise.all(stale.docs.map((d) => d.ref.delete()));
  },
);

/* ------------------------------------------------------------ importing */

/** Access to a member's Google Calendar for the private assistant, or null if not linked. */
export async function importAccess(uid) {
  const account = (await accountRef(uid).get()).data();
  if (!account?.refreshToken || account.revoked) return null;
  return { canImport: canImport(account.scope), api: () => apiFor(uid, account) };
}

const ASK_EVERY_MS = 20 * 60 * 60 * 1000;

/** Pushes to one member's devices (data-only; the service worker shows it). */
async function pushTo(uid, data) {
  const snap = await getFirestore().collection("tokens").where("uid", "==", uid).get();
  if (snap.empty) return;
  const res = await getMessaging().sendEachForMulticast({
    tokens: snap.docs.map((d) => d.id),
    webpush: { data, headers: { Urgency: "normal", TTL: "43200" } },
  });
  logger.info(`gcal ${uid}: asked on ${res.successCount} device(s)`);
}

export const gcalImport = onSchedule(
  { schedule: "every 30 minutes", region: "us-central1", timeZone: FAMILY_TZ, secrets: SECRETS, timeoutSeconds: 540 },
  async () => {
    const db = getFirestore();
    const store = firestoreStore(db);
    const now = familyNow();
    for (const account of await linkedAccounts()) {
      if (!canImport(account.scope)) continue;
      const { uid } = account;
      // Members who allowed reading but never asked yet start with their main calendar.
      const settings = (await store.get(`users/${uid}/settings/gcalImport`)) || {};
      const by = (await getAuth().getUser(uid).catch(() => null))?.displayName?.split(" ")[0] || account.email;
      const audit = (action, targetId, before, after) => store.add("auditLog", {
        action, targetId, before: before ?? null, after: after ?? null, by, byUid: uid, request: null, via: "gcal",
      });
      const imp = importer({ store, api: () => apiFor(uid, account), uid, by, now, audit, log: (...a) => logger.warn(...a) });
      try {
        await imp.follow();
        const waiting = await imp.refreshOffers();
        const fresh = waiting.filter((o) => o.status === "new");
        const hour = +now.time.slice(0, 2);
        if (fresh.length && hour >= 8 && hour < 20 && Date.now() - (settings.lastAskedAt || 0) > ASK_EVERY_MS) {
          const text = digestText(fresh.map((o) => ({ n: o.n, title: o.title, when: o.when, calendar: o.calendarName })));
          await db.collection(`users/${uid}/thread`).add({
            uid: "assistant", name: "Family Assistant", photo: "", channel: "private", kind: "reply",
            text, refs: { events: [], places: [] }, links: [], createdAt: FieldValue.serverTimestamp(),
          });
          for (const o of fresh) await store.update(`users/${uid}/gcalOffers`, o.id, { status: "asked" });
          await imp.saveSettings({ lastAskedAt: Date.now() });
          await pushTo(uid, { title: "✨ Family Assistant", body: `${fresh.length === 1 ? "A new event" : `${fresh.length} new events`} in your calendar: add to the family calendar?`, id: "gcal-ask-" + uid, url: "/#assistant/me" });
        }
      } catch (e) {
        if (isRevoked(e)) continue;
        logger.error(`gcal ${uid}: import run failed`, e);
      }
      const calendarChanges = imp.changes.filter((c) => c.kind === "event");
      if (calendarChanges.length) {
        await db.collection("messages").add({
          uid: "assistant", name: "Family Assistant", photo: "", channel: "family", kind: "notice",
          text: `From ${by}'s calendar: ${calendarChanges.map((c) => c.summary.replace(` from ${by}'s calendar`, "")).join("; ")}.`.slice(0, 1000),
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    }
  },
);

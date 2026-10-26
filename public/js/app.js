// family.vaschuk.com: family chat, assistant, shared calendar, map and memory.
//
// Data (Firestore, project vaschuk-com):
//   messages   family chat + assistant requests/replies (channel "family" | "assistant")
//   events     shared calendar        ┐
//   places     saved places + home    │ written only by the assistant
//   memory     remembered facts       │ (functions/), readable by the family
//   auditLog   every assistant change ┘
//   users/{uid}/thread, /memory, /auditLog
//              each member's private assistant thread, private memory and
//              its log: only that member can read them
// Future: kids' live locations will go in a separate collection once their
// phones have accounts; the map is built to take another marker layer.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, collection, doc, query, orderBy, limit, limitToLast, onSnapshot, addDoc, setDoc, deleteDoc, getDocs, disableNetwork, enableNetwork, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getMessaging, getToken, deleteToken, isSupported } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging.js";
import {
  FAMILY_TZ, familyNow, agenda, occurrences, addDays, dateOf, timeOf,
  describeRecurrence, directionsUrl,
} from "./recurrence.js";
// Production or dev project, picked by where the page is hosted.
import { firebaseConfig, VAPID_KEY } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const messagesRef = collection(db, "messages");

const ASSISTANT_UID = "assistant";
const REMINDER_BUFFER_MIN = 10;
const DEFAULT_DRIVE_MIN = 20;

const $ = (id) => document.getElementById(id);
const screens = ["welcome", "uninvited", "app"];
const show = (name) => screens.forEach((s) => ($(s).hidden = s !== name));

/** Tiny DOM helper: h("div.cls", { onclick }, ...children). */
function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split(".");
  const el = document.createElement(name || "div");
  if (cls.length) el.className = cls.join(" ");
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

/* ------------------------------------------------------------------ state */

const state = {
  user: null,
  msgs: [],
  events: [],
  places: [],
  memory: [],
  audit: [],
  mine: [], // my private thread
  myMemory: [],
  gcal: null, // my Google Calendar link status (users/{uid}/settings/gcal)
  tab: "family",
  scope: "family", // assistant tab: "family" or "me" (private thread)
  week: sundayOf(familyNow().date),
  who: null, // calendar filter
  focusPlace: null,
};
function sundayOf(ymd) { return addDays(ymd, -new Date(ymd + "T12:00:00Z").getUTCDay()); }
const placeById = (id) => state.places.find((p) => p.id === id);
const eventById = (id) => state.events.find((e) => e.id === id);
const home = () => state.places.find((p) => p.isHome);
const myThread = () => collection(db, "users", state.user.uid, "thread");
let unsubs = [];

/* ------------------------------------------------------------------- auth */

$("signin").onclick = async () => {
  $("signin-error").textContent = "";
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      $("signin-error").textContent = "Couldn't sign in. Please try again.";
      console.error(e);
    }
  }
};
$("signout").onclick = $("switch").onclick = async () => {
  // Stop this device getting the family's notifications after sign-out.
  if (pushToken) {
    try {
      await deleteDoc(doc(db, "tokens", pushToken));
      await deleteToken(messaging);
    } catch (e) {
      console.error(e);
    }
    pushToken = null;
  }
  signOut(auth);
};

/* -------------------------------------------------------------- push (FCM) */
// Each device that opts in stores its token in tokens/{token}; Cloud Functions
// push family-chat messages and "time to leave" reminders to them.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let messaging = null;
let pushToken = null;
let pushStarted = false;
const pushReady = isSupported()
  .then((ok) => ok && !!VAPID_KEY && "Notification" in window && (messaging = getMessaging(app), true))
  .catch(() => false);

async function setupPush(user, ask) {
  if (!(await pushReady)) {
    if (isIOS && !standalone) hint("ios", "To get notifications on iPhone: tap Share, then “Add to Home Screen”, and open Family from your Home Screen.");
    return;
  }
  if (Notification.permission === "denied") {
    $("bell").hidden = true;
    hint("denied", "Notifications are blocked for this site. Allow them in your browser's site settings to get messages and leave-time reminders.");
    return;
  }
  if (Notification.permission !== "granted") {
    if (!ask) return void ($("bell").hidden = false);
    if (await Notification.requestPermission() !== "granted") return void ($("bell").hidden = true);
  }
  $("bell").hidden = true;
  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  pushToken = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  await setDoc(doc(db, "tokens", pushToken), { uid: user.uid, updatedAt: serverTimestamp() });
}

// The service worker notifies even while this page is open; once the chat
// is on screen, chat notifications are old news. Leave-time reminders stay.
async function clearNotifications() {
  if (document.visibilityState !== "visible" || !("serviceWorker" in navigator)) return;
  if (state.tab !== "family" && state.tab !== "assistant") return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  (await registration?.getNotifications() || []).filter((n) => !String(n.tag).startsWith("leave-")).forEach((n) => n.close());
}
document.addEventListener("visibilitychange", () => {
  if (!$("app").hidden) clearNotifications().catch(console.error);
});

$("bell").onclick = () => setupPush(auth.currentUser, true).catch((e) => {
  console.error(e);
  hint("error", "Couldn't turn on notifications. Please try again.");
});

function hint(key, text) {
  try { if (localStorage.getItem("hint-dismissed-" + key)) return; } catch {}
  $("hint-text").textContent = text;
  $("hint").dataset.key = key;
  $("hint").hidden = false;
}
$("hint-close").onclick = () => {
  $("hint").hidden = true;
  try { localStorage.setItem("hint-dismissed-" + $("hint").dataset.key, "1"); } catch {}
};

let toastTimer;
function toast(text, ms = 2200) {
  document.querySelector(".toast")?.remove();
  const t = h("div.toast", { role: "status" }, text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

onAuthStateChanged(auth, (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];
  pushStarted = false;
  state.user = user;
  $("bell").hidden = $("hint").hidden = true;
  if (!user) return show("welcome");

  $("me-name").textContent = user.displayName || user.email;
  $("me-avatar").replaceChildren(avatar(user.photoURL, user.displayName || user.email));

  // The security rules only let family members read, so a permission
  // error here means this account isn't on the list.
  const denied = (err) => {
    if (err.code === "permission-denied") {
      $("uninvited-email").textContent = user.email;
      show("uninvited");
    } else {
      console.error(err);
    }
  };
  unsubs.push(onSnapshot(query(messagesRef, orderBy("createdAt"), limitToLast(300)), (snap) => {
    show("app");
    state.msgs = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderMessages();
    clearNotifications().catch(console.error);
    if (!pushStarted) {
      pushStarted = true;
      setupPush(user, false).catch(console.error);
    }
  }, denied));
  const watch = (name, q, key, after) => unsubs.push(onSnapshot(q, (snap) => {
    state[key] = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    after();
  }, (err) => err.code !== "permission-denied" && console.error(name, err)));
  const all = () => { renderMessages(); renderCalendar(); renderMap(); renderMemory(); };
  watch("events", collection(db, "events"), "events", all);
  watch("places", collection(db, "places"), "places", all);
  watch("memory", query(collection(db, "memory"), orderBy("createdAt")), "memory", renderMemory);
  watch("auditLog", query(collection(db, "auditLog"), orderBy("createdAt", "desc"), limit(60)), "audit", renderMemory);
  watch("thread", query(myThread(), orderBy("createdAt"), limitToLast(300)), "mine", renderMessages);
  watch("myMemory", query(collection(db, "users", user.uid, "memory"), orderBy("createdAt")), "myMemory", renderMemory);
  unsubs.push(onSnapshot(doc(db, "users", user.uid, "settings", "gcal"), (snap) => {
    state.gcal = snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : null;
    renderGcal();
  }, (err) => err.code !== "permission-denied" && console.error("gcal", err)));
  route();
});

/* ---------------------------------------------------------------- routing */
// #family #assistant #assistant/me #calendar #map #map/<placeId> #memory #export

const TABS = ["family", "assistant", "calendar", "map", "memory"];
function route() {
  const [tab, arg] = location.hash.slice(1).split("/");
  if (tab === "export") {
    history.replaceState(null, "", "#memory");
    exportJson().catch(console.error);
    return route();
  }
  state.tab = TABS.includes(tab) ? tab : "family";
  state.focusPlace = state.tab === "map" ? arg || null : null;
  if (state.tab === "assistant") {
    state.scope = arg === "me" ? "me" : "family";
    try { localStorage.setItem("assistant-scope", state.scope); } catch {}
    $("assistant-list").hidden = state.scope === "me";
    $("private-list").hidden = state.scope !== "me";
    $("gcal-card").hidden = state.scope !== "me";
    $("scope-family").setAttribute("aria-pressed", String(state.scope === "family"));
    $("scope-me").setAttribute("aria-pressed", String(state.scope === "me"));
  }
  for (const t of TABS) $("view-" + t).hidden = t !== state.tab;
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  $("compose").hidden = state.tab !== "family" && state.tab !== "assistant";
  updateComposer();
  if (state.tab === "family" || state.tab === "assistant") {
    const box = $("view-" + state.tab);
    requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
    clearNotifications().catch(console.error);
  }
  if (state.tab === "calendar") renderCalendar();
  if (state.tab === "map") renderMap();
  if (state.tab === "memory") renderMemory();
}
addEventListener("hashchange", route);
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => go(b.dataset.tab === "assistant" ? assistantHash() : b.dataset.tab)));
/** The assistant tab opens on whichever conversation (family or private) was used last. */
function assistantHash() {
  try { if (localStorage.getItem("assistant-scope") === "me") return "assistant/me"; } catch {}
  return "assistant";
}
const go = (hash) => {
  if (location.hash === "#" + hash) route();
  else location.hash = hash;
};

/* ------------------------------------------------------------- formatting */

const PALETTE = ["#c8643b", "#5f8a5a", "#4f7bb8", "#a35fa8", "#c49a2c", "#3a9a9a", "#b8505f"];
function colorFor(name) {
  let x = 0;
  for (const ch of String(name || "").toLowerCase()) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[x % PALETTE.length];
}
const time12 = (t) => {
  if (!t) return "";
  const hr = +t.slice(0, 2), m = t.slice(3, 5);
  return `${hr % 12 || 12}${m === "00" ? "" : ":" + m} ${hr < 12 ? "AM" : "PM"}`;
};
const dayFmt = (ymd, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
const msgTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: FAMILY_TZ });
const stampText = (ts) => (ts?.toDate ? msgTime.format(ts.toDate()) : "");

function timeRange(o) {
  if (o.allDay) return "All day";
  return time12(timeOf(o.start)) + (o.end ? "–" + time12(timeOf(o.end)) : "");
}
function leaveBy(ev, startTime) {
  const p = ev.placeId && placeById(ev.placeId);
  if (ev.allDay || !p || p.lat == null || ev.remind === false || !startTime) return "";
  const drive = p.driveMinutes ?? DEFAULT_DRIVE_MIN;
  const t = +startTime.slice(0, 2) * 60 + +startTime.slice(3) - drive - REMINDER_BUFFER_MIN;
  const hhmm = `${String(Math.floor((((t % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String(((t % 60) + 60) % 60).padStart(2, "0")}`;
  return `🚗 leave by ${time12(hhmm)}${p.driveMinutes != null ? ` · ${drive} min drive` : ""}`;
}
const telHref = (phone) => "tel:" + String(phone).replace(/[^\d+]/g, "");

function avatar(url, name) {
  if (url) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = url;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    return img;
  }
  return h("span.avatar", {}, (name || "?").trim()[0].toUpperCase());
}

/* -------------------------------------------------- shared place / event UI */

function placeButtons(p, { mapLink = true } = {}) {
  return h("div.row", {},
    h("a.btn.go", { href: directionsUrl(p), target: "_blank", rel: "noopener" }, "🧭 Navigate"),
    p.phone && h("a.btn", { href: telHref(p.phone) }, "📞 Call"),
    mapLink && p.lat != null && h("a.btn", { href: "#map/" + p.id }, "📍 Map"),
    h("button.btn", { type: "button", onclick: () => sharePlace(p) }, "↗ Share"),
  );
}

async function sharePlace(p, ev) {
  const next = nextAt(p.id);
  const lines = [p.name, p.address, p.phone && "📞 " + p.phone,
    ev ? `${ev.title}` : next && `Next: ${next.event.title}, ${dayFmt(next.date)} ${timeRange(next)}`,
    "Directions: " + directionsUrl(p)].filter(Boolean);
  const text = lines.join("\n");
  try {
    if (navigator.share) return void (await navigator.share({ title: p.name, text }));
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied place details");
  } catch {
    prompt("Copy this:", text);
  }
}

function nextAt(placeId) {
  const now = familyNow();
  return agenda(state.events.filter((e) => e.placeId === placeId), now.date, addDays(now.date, 60))
    .find((o) => o.allDay ? o.date >= now.date : o.start >= now.dateTime) || null;
}

/** Card for an event; with `occ` it shows that date, else the next one / its rule. */
function eventCard(ev, occ) {
  const now = familyNow();
  if (!occ) {
    occ = ev.recurrence
      ? agenda([ev], now.date, addDays(now.date, 120)).find((o) => o.allDay ? o.date >= now.date : o.start >= now.dateTime)
      : occurrences(ev, dateOf(ev.start), dateOf(ev.end || ev.start))[0];
  }
  const p = ev.placeId && placeById(ev.placeId);
  const color = colorFor(ev.who?.[0] || ev.title);
  const when = occ ? `${dayFmt(occ.date)} · ${timeRange(occ)}` : "No upcoming dates";
  const leave = occ && !occ.allDay && occ.date >= now.date ? leaveBy(ev, timeOf(occ.start)) : "";
  return h("div.ev", { style: `--c:${color}` },
    h("div.bar"),
    h("div.body", {},
      h("div.row", {}, h("span.title", {}, ev.title), ...(ev.who || []).map((w) => h("span.chip", { style: `--c:${colorFor(w)}` }, w))),
      h("div.when", {}, when, ev.recurrence ? ` · ${describeRecurrence(ev.recurrence)}` : ""),
      p ? h("button.placelink", { type: "button", onclick: () => go("map/" + p.id) }, "📍 " + p.name)
        : ev.location ? h("div.when", {}, "📍 " + ev.location + " (not on map)") : null,
      leave && h("div.when", {}, leave),
      ev.notes && h("div.notes", {}, ev.notes),
      p && placeButtons(p, { mapLink: false }),
    ),
  );
}

/* --------------------------------------------------------------- messages */

const isRequest = (m) => m.uid !== ASSISTANT_UID && !m.kind && (m.channel === "assistant" || m.channel === "private" || String(m.text || "").trimStart().startsWith("/"));
const inFamily = (m) => (m.channel || "family") === "family";
const inAssistant = (m) => (m.channel === "assistant" || isRequest(m) || (m.uid === ASSISTANT_UID && m.kind !== "notice"));

function renderMessages() {
  renderList($("family-list"), state.msgs.filter(inFamily), "family");
  renderList($("assistant-list"), state.msgs.filter(inAssistant), "assistant");
  renderList($("private-list"), state.mine, "private");
}

function renderList(box, msgs, where) {
  const view = box.parentElement;
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
  const myUid = state.user?.uid;
  box.replaceChildren();
  if (!msgs.length) box.append(where === "family" ? emptyFamily() : where === "private" ? emptyPrivate() : emptyAssistant());
  for (const m of msgs) {
    if (m.kind === "notice") {
      box.append(h("div.notice", {}, "📅 " + m.text));
      continue;
    }
    const bot = m.uid === ASSISTANT_UID;
    const req = isRequest(m);
    const row = h("div.msg" + (m.uid === myUid ? ".mine" : "") + (req ? ".cmd" : "") + (bot ? ".bot" : ""));
    const meta = h("div.meta", {}, h("b", {}, m.name), " · " + stampText(m.createdAt));
    if (where === "assistant" && req && inFamily(m)) meta.append(h("span.tag", {}, "in family chat"));
    if (where === "family" && req) meta.append(h("span.tag", {}, "✨ to assistant"));
    const text = h("div.text");
    const body = String(m.text || "");
    if (req && body.trimStart().startsWith("/")) text.append(h("span.slash", {}, "/"), body.trimStart().slice(1));
    else text.textContent = body;
    const bubble = h("div.bubble", {}, meta, text);
    const extra = req ? statusLine(m) : bot ? attachments(m) : null;
    if (extra) bubble.append(extra);
    row.append(bot ? h("span.avatar.bot", {}, "✨") : avatar(m.photo, m.name), bubble);
    box.append(row);
  }
  if (nearBottom || msgs.at(-1)?.uid === myUid) view.scrollTop = view.scrollHeight;
}

function statusLine(m) {
  if (m.status === "error") return h("div.status.err", {}, h("span.label", {}, "✨ couldn't finish"), refreshButton());
  if (m.status === "done") return null;
  const since = m.createdAt?.toDate ? m.createdAt.toDate().getTime() : Date.now();
  const el = h("div.status", { "data-id": m.id, "data-since": since, "data-thinking": m.status === "thinking" ? "1" : "" },
    h("span.label"), refreshButton());
  paintStatus(el);
  return el;
}

// Reloading also picks up a newer version of the page, so it fixes a stale
// connection and stale code alike, without scrolling up to the browser's own.
const refreshButton = () => h("button.refresh", { type: "button", onclick: () => location.reload() }, "↻ Refresh");
const SHOW_REFRESH_AFTER_S = 10;

/**
 * Text for a pending request's status line; the ticker below keeps it current.
 * Time alone never turns it into an error: only the server can say that the
 * assistant never picked a request up (or failed, which arrives as status).
 */
function paintStatus(el) {
  const secs = Math.max(0, Math.round((Date.now() - +el.dataset.since) / 1000));
  const server = serverStatus.get(el.dataset.id);
  const unclaimed = secs > UNCLAIMED_AFTER_S && server && !server.status;
  el.classList.toggle("err", !!unclaimed);
  el.querySelector(".label").classList.toggle("working", !unclaimed);
  el.querySelector(".refresh").hidden = !unclaimed && secs < SHOW_REFRESH_AFTER_S;
  el.querySelector(".label").textContent = unclaimed ? "✨ the assistant didn't pick this up. Please send it again."
    : el.dataset.thinking || server?.status === "thinking"
      ? secs > SLOW_AFTER_S ? `✨ still working, taking longer than usual · ${secs}s` : `✨ working on it · ${secs}s`
    : secs < 5 ? "✨ sent to the assistant"
    : `✨ waiting for the assistant · ${secs}s`;
}

/* ------------------------------------------------- keeping the chat fresh */
// Phones (iOS especially) can leave Firestore's live connection silently
// stalled after the app was in the background: the assistant answers, but the
// page never hears about it. While a request is pending, ask the server for
// its status every few seconds over a plain HTTPS request (the live connection
// may be the thing that's stuck), restart the connection if the page is
// behind, and reload the page if that didn't help. Also restart it when the
// app comes back to the foreground or goes online.

const UNCLAIMED_AFTER_S = 60; // the function normally marks a request within a second or two
const SLOW_AFTER_S = 90;
const WATCH_FOR_S = 600;
const CHECK_EVERY_MS = 5000;
const RELOAD_AFTER_MS = 10000; // behind for this long even after reconnecting
const serverStatus = new Map(); // request id -> { status }
let lastCheck = 0;
let resyncing = null;
let lastResync = 0;
let behindSince = 0;

function resync() {
  if (resyncing || Date.now() - lastResync < 3000) return resyncing;
  lastResync = Date.now();
  resyncing = disableNetwork(db).then(() => enableNetwork(db))
    .catch(console.error)
    .finally(() => { resyncing = null; });
  return resyncing;
}

/** A request's status read over the Firestore REST API (null if not set yet). */
async function fetchStatus(m) {
  const token = await auth.currentUser.getIdToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const path = m.channel === "private" ? `users/${m.uid}/thread/${m.id}` : `messages/${m.id}`;
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${path}?mask.fieldPaths=status`;
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`status check ${res.status}`);
    return (await res.json()).fields?.status?.stringValue || null;
  } finally {
    clearTimeout(timer);
  }
}

function reloadOnce() {
  // Never loop: at most one automatic reload a minute.
  try {
    if (Date.now() - +(sessionStorage.getItem("chat-reloaded-at") || 0) < 60000) return;
    sessionStorage.setItem("chat-reloaded-at", String(Date.now()));
  } catch {}
  location.reload();
}

async function checkPending() {
  const age = (m) => Date.now() - m.createdAt.toDate().getTime();
  const pending = [...state.msgs, ...state.mine].filter((m) => isRequest(m) && m.status !== "done" && m.status !== "error"
    && m.createdAt?.toDate && age(m) < WATCH_FOR_S * 1000);
  // Give the live connection a few seconds before second-guessing it.
  const oldest = pending.find((m) => age(m) > 4000);
  if (!oldest) return void (behindSince = 0);
  const status = await fetchStatus(oldest);
  serverStatus.set(oldest.id, { status });
  if (status === (oldest.status || null)) return void (behindSince = 0);
  if (!behindSince) behindSince = Date.now();
  if (Date.now() - behindSince > RELOAD_AFTER_MS) return reloadOnce();
  await resync();
}

setInterval(() => {
  document.querySelectorAll(".status[data-since]").forEach(paintStatus);
  if (!state.user || document.visibilityState !== "visible" || Date.now() - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = Date.now();
  checkPending().catch(console.error);
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (state.user && document.visibilityState === "visible") resync();
});
addEventListener("online", () => state.user && resync());

function attachments(m) {
  const box = h("div.attach");
  const shownPlaces = new Set();
  for (const id of m.refs?.events || []) {
    const ev = eventById(id);
    if (!ev) continue;
    if (ev.placeId) shownPlaces.add(ev.placeId);
    box.append(eventCard(ev));
  }
  for (const id of m.refs?.places || []) {
    const p = placeById(id);
    if (!p || shownPlaces.has(id)) continue;
    box.append(h("div.place", {},
      h("span.name", {}, (p.isHome ? "🏠 " : "📍 ") + p.name),
      p.address && h("span.addr", {}, p.address),
      p.phone && h("span.addr", {}, "📞 " + p.phone),
      placeButtons(p)));
  }
  // A directions link is redundant when its place's card (with Navigate) is shown.
  const shown = new Set([...(m.refs?.places || []).filter((id) => placeById(id)), ...shownPlaces]);
  const links = (m.links || []).filter((l) => l.kind !== "directions" || !(l.placeId && shown.has(l.placeId)));
  if (links.length) {
    box.append(h("div.row", {}, ...links.map((l) => l.url === "#export"
      ? h("button.btn.primary", { type: "button", onclick: () => exportJson() }, "⬇ " + l.label)
      : h("a.btn.go", { href: l.url, target: "_blank", rel: "noopener" }, "🧭 " + l.label))));
  }
  return box.childNodes.length ? box : null;
}

function emptyFamily() {
  return h("div.empty", {}, "No messages yet. Say hello! 👋", h("br"), h("small", {}, "Start a message with / to ask the assistant."));
}
function emptyAssistant() {
  const ideas = [
    "What's on this week?",
    "Add Maria's ballet Tue/Thu 6:30–8 PM",
    "Our home address is …",
    "Navigate to ballet",
    "What do you remember?",
  ];
  return h("div.empty", {},
    h("div", {}, "✨ Ask me to keep the kids' schedule, find places, give directions, or remember things. Everything here is shared with the family."),
    h("div.suggest", {}, ...ideas.map((t) => h("button.btn", { type: "button", onclick: () => fill(t.endsWith("…") ? t.slice(0, -1) : t) }, t))));
}

function emptyPrivate() {
  const ideas = [
    "What's on my plate this week?",
    "Remember that I work late on Wednesdays",
    "What do you remember about me?",
  ];
  return h("div.empty", {},
    h("div", {}, "🔒 Just you and the assistant. The family doesn't see this conversation or what it remembers for you here. Calendar changes are still shared: the family sees them, with a short note in the family chat."),
    h("div.suggest", {}, ...ideas.map((t) => h("button.btn", { type: "button", onclick: () => fill(t) }, t))));
}

/* -------------------------------------------------------- Google Calendar */
// Each member can link their Google Calendar; the gcal function (behind
// /gcal/* on this site) copies every family event into a "Vaschuk Family"
// calendar there. Tokens never reach the page: it only sees the status doc.

async function gcalCall(action, body) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch("/gcal/" + action, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`gcal ${action}: ${res.status}`);
  return res.json();
}

async function gcalAction(action, button) {
  if (action === "disconnect" && !confirm("Stop copying family events to your Google Calendar? The “Vaschuk Family” calendar will be removed from your Google account.")) return;
  button.disabled = true;
  try {
    // "start-import" also asks Google to let the site read their calendars.
    const out = action === "start-import" ? await gcalCall("start", { import: true }) : await gcalCall(action);
    if (out.url) return void (location.href = out.url);
    toast(action === "resync" ? "Copying family events again…" : "Google Calendar disconnected");
  } catch (e) {
    console.error(e);
    alert("That didn't work. Please try again in a minute.");
  } finally {
    button.disabled = false;
  }
}

function renderGcal() {
  const s = state.gcal;
  const card = $("gcal-card");
  const btn = (label, action, cls = "") => h("button.btn" + cls, { type: "button", onclick: (e) => gcalAction(action, e.currentTarget) }, label);
  card.classList.toggle("err", s?.state === "error");
  if (!s || s.state === "off") {
    card.replaceChildren(
      h("span.what", {}, "📅 Get every family event in your Google Calendar", h("span.sub", {}, "Adds a “Vaschuk Family” calendar to your Google account and keeps it up to date.")),
      btn("Connect Google Calendar", "start", ".primary"));
  } else if (s.state === "error") {
    card.replaceChildren(
      h("span.what", {}, "⚠️ Google Calendar isn't syncing", h("span.sub", {}, s.error || "")),
      h("div.row", {}, btn("Reconnect", s.canImport ? "start-import" : "start", ".primary"), btn("Disconnect", "disconnect")));
  } else {
    const when = s.state === "syncing" ? "copying family events…" : s.lastSyncAt ? `synced ${stampText(s.lastSyncAt)}` : "";
    card.replaceChildren(
      h("span.what", {}, "📅 Family events go to “Vaschuk Family” in your Google Calendar",
        h("span.sub", {}, [s.email, when, s.error].filter(Boolean).join(" · "))),
      h("div.row", {}, btn("Sync now", "resync"), btn("Disconnect", "disconnect")),
      // Bringing their own events into the family calendar (the private assistant asks which).
      s.canImport
        ? h("div.import", {}, h("span.sub", {}, "You can also bring events from your own calendars in; the assistant asks you which."),
          h("button.btn", { type: "button", onclick: () => fill("What's new in my calendar?") }, "🔎 Check my calendar"))
        : h("div.import", {}, h("span.sub", {}, "Want some of your own events in the family calendar too? Google will ask to let the site read your calendars."),
          btn("Bring in my events", "start-import")));
  }
}

// Back from Google's consent screen: /?gcal=<result>#assistant/me
{
  const result = new URLSearchParams(location.search).get("gcal");
  if (result) {
    history.replaceState(null, "", location.pathname + location.hash);
    toast({
      connected: "Google Calendar connected. Copying family events…",
      denied: "Google Calendar wasn't connected (calendar access is needed).",
      expired: "That took too long. Please tap Connect again.",
    }[result] || "Couldn't connect Google Calendar. Please try again.");
  }
}

/* --------------------------------------------------------------- composer */

const input = $("text");
function fill(text, tab = "assistant") {
  if (state.tab !== tab) go(tab === "assistant" ? assistantHash() : tab);
  input.value = text;
  updateComposer();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

function updateComposer() {
  const toAssistant = state.tab === "assistant";
  const priv = toAssistant && state.scope === "me";
  const ask = toAssistant || input.value.trimStart().startsWith("/");
  $("compose").classList.toggle("ask", ask);
  $("to").hidden = !priv && (!ask || toAssistant);
  $("to").textContent = priv ? "🔒 Only you and the assistant" : "✨ To the assistant";
  $("send").textContent = ask ? "Ask" : "Send";
  $("mode").textContent = toAssistant ? "💬" : "✨";
  $("mode").title = $("mode").ariaLabel = toAssistant ? "Switch to family chat" : "Switch to the assistant";
  input.placeholder = priv ? "Ask privately…"
    : toAssistant
    ? "Ask the assistant…"
    : "Message, or /ask the assistant";
  input.style.height = "auto";
  input.style.height = Math.max(44, input.scrollHeight + 2) + "px";
}
input.addEventListener("input", updateComposer);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("compose").requestSubmit();
  }
});
// Switch between talking to the family and talking to the assistant; the draft comes along.
$("mode").onclick = () => {
  const toFamily = state.tab === "assistant";
  let text = input.value;
  if (!toFamily && text.trimStart().startsWith("/")) text = text.trimStart().slice(1).trimStart();
  go(toFamily ? "family" : assistantHash());
  input.value = text;
  updateComposer();
  input.focus();
};

/* -------------------------------------------------------------- dictation */
// Speech to text with the browser's own recognizer (Web Speech API: Chrome,
// Edge, Safari; the button stays hidden where there is none). The words land
// in the message box to check and fix; nothing is sent until Send is tapped.
//
// One phrase per tap: in continuous mode phone browsers report each partial
// guess ("what's", "what's on", ...) as its own final result, which repeats
// words. Without it the latest result always holds the whole phrase.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let dictation = null;
$("mic").hidden = !Recognition;

function setListening(on) {
  $("mic").classList.toggle("on", on);
  $("mic").setAttribute("aria-pressed", String(on));
  $("mic").textContent = on ? "■" : "🎤";
  $("mic").ariaLabel = $("mic").title = on ? "Stop listening" : "Speak your message";
  if (on) input.placeholder = "Listening…";
  else updateComposer();
}

const DICTATION_ERRORS = {
  "not-allowed": "Microphone access is blocked. Allow it for this site (the icon next to the address), then try again.",
  "service-not-allowed": "This browser doesn't allow speech recognition here. Try the keyboard's own dictation key.",
  "audio-capture": "No microphone found, or another app is using it.",
  "no-speech": "Didn't hear anything. Check that the right microphone is on and not muted.",
  network: "The browser couldn't reach its speech recognition service. Check the connection and try again.",
  "language-not-supported": "Speech recognition doesn't support this device's language.",
};

function startDictation() {
  const rec = new Recognition();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  // Speech is added after whatever is already typed.
  const typed = input.value.trim();
  rec.onresult = (e) => {
    if (dictation !== rec) return;
    const said = e.results[e.results.length - 1][0].transcript.trim();
    input.value = [typed, said].filter(Boolean).join(" ");
    updateComposer();
  };
  rec.onerror = (e) => {
    console.warn("dictation error:", e.error, e.message);
    if (e.error !== "aborted") toast(DICTATION_ERRORS[e.error] || `Speech to text failed (${e.error}).`, 6000);
  };
  rec.onend = () => {
    if (dictation !== rec) return;
    dictation = null;
    setListening(false);
    input.focus();
  };
  dictation = rec;
  try {
    rec.start();
  } catch (err) {
    console.warn("dictation start failed:", err);
    dictation = null;
    toast(`Speech to text couldn't start (${err.name}).`, 6000);
    return;
  }
  setListening(true);
}
/** Stops listening; the phrase heard so far still arrives. */
const stopDictation = () => dictation?.stop();
/** Stops listening and drops anything still on its way (after Send). */
function cancelDictation() {
  const rec = dictation;
  if (!rec) return;
  dictation = null;
  rec.abort();
  setListening(false);
}

$("mic").onclick = () => (dictation ? stopDictation() : startDictation());
addEventListener("hashchange", stopDictation);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && stopDictation());

$("compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  cancelDictation();
  const text = input.value.trim();
  const user = auth.currentUser;
  if (!text || !user || text === "/") return;
  $("send").disabled = true;
  try {
    const priv = state.tab === "assistant" && state.scope === "me";
    await addDoc(priv ? myThread() : messagesRef, {
      text,
      uid: user.uid,
      name: user.displayName || user.email,
      photo: user.photoURL || "",
      channel: priv ? "private" : state.tab === "assistant" ? "assistant" : "family",
      createdAt: serverTimestamp(),
    });
    input.value = "";
    updateComposer();
  } catch (err) {
    console.error(err);
    alert("Message didn't send. Please try again.");
  } finally {
    $("send").disabled = false;
    input.focus();
  }
});

/* --------------------------------------------------------------- calendar */

function renderCalendar() {
  const view = $("view-calendar");
  if (view.hidden) return;
  const now = familyNow();
  const from = state.week, to = addDays(from, 6);
  const people = [...new Set(state.events.flatMap((e) => e.who || []))].sort();
  if (state.who && !people.includes(state.who)) state.who = null;
  const events = state.who ? state.events.filter((e) => (e.who || []).includes(state.who)) : state.events;
  const occ = agenda(events, from, to);
  const label = `${dayFmt(from, { month: "short", day: "numeric" })} – ${dayFmt(to, from.slice(5, 7) === to.slice(5, 7) ? { day: "numeric" } : { month: "short", day: "numeric" })}`;

  const bar = h("div.calbar", {},
    h("div.row", {},
      h("button.btn", { type: "button", "aria-label": "Previous week", onclick: () => { state.week = addDays(state.week, -7); renderCalendar(); } }, "‹"),
      h("h3", {}, label),
      h("button.btn", { type: "button", "aria-label": "Next week", onclick: () => { state.week = addDays(state.week, 7); renderCalendar(); } }, "›")),
    h("div.row.wrap", {},
      h("button.btn", { type: "button", "aria-pressed": String(state.week === sundayOf(now.date)), onclick: () => { state.week = sundayOf(now.date); renderCalendar(); } }, "This week"),
      people.length > 1 && h("button.btn", { type: "button", "aria-pressed": String(!state.who), onclick: () => { state.who = null; renderCalendar(); } }, "Everyone"),
      ...(people.length > 1 ? people : []).map((p) => h("button.btn", { type: "button", "aria-pressed": String(state.who === p), onclick: () => { state.who = p; renderCalendar(); } }, h("span.chip", { style: `--c:${colorFor(p)}` }, p))),
      h("button.btn.primary", { type: "button", onclick: () => fill("Add ") }, "✨ Add")),
  );
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const list = occ.filter((o) => o.date === d || (o.allDay && o.date < d && o.end >= d));
    days.push(h("section.day" + (d === now.date ? ".today" : ""), {},
      h("h4", {}, dayFmt(d, { weekday: "long", month: "short", day: "numeric" }) + (d === now.date ? " · Today" : "")),
      list.length ? list.map((o) => eventCard(o.event, o)) : h("p.none", {}, "—")));
  }
  const empty = !state.events.length && h("div.empty", {},
    "The family calendar is empty.", h("br"),
    h("button.btn.primary", { type: "button", style: "margin-top:12px", onclick: () => fill("Add Maria's ballet Tue/Thu 6:30–8 PM") }, "✨ Add an activity with the assistant"));
  view.replaceChildren(bar, empty || h("div", {}, ...days));
}

/* -------------------------------------------------------------------- map */

let leaflet = null; // { L, map, layer }
// One shared load: renderMap runs on every snapshot, and a second <script>
// would replace window.L with a copy the existing map doesn't recognize.
let leafletLoad = null;
function loadLeaflet() {
  return leafletLoad ||= new Promise((resolve, reject) => {
    const css = h("link", { rel: "stylesheet", href: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", crossOrigin: "" });
    const js = h("script", { src: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", crossOrigin: "", onload: () => resolve(window.L), onerror: (e) => { leafletLoad = null; reject(e); } });
    document.head.append(css, js);
  });
}

async function renderMap() {
  const view = $("view-map");
  if (view.hidden) return;
  const now = familyNow();
  const soon = new Set(agenda(state.events, now.date, addDays(now.date, 7)).map((o) => o.event.placeId).filter(Boolean));
  const places = [...state.places].sort((a, b) => (!!b.isHome - !!a.isHome) || (soon.has(b.id) - soon.has(a.id)) || a.name.localeCompare(b.name));

  // List under the map.
  const list = $("place-list");
  list.replaceChildren(...(places.length ? places.map((p) => {
    const next = nextAt(p.id);
    return h("div.place" + (state.focusPlace === p.id ? ".focus" : ""), { id: "place-" + p.id },
      h("span.name", {}, (p.isHome ? "🏠 " : "📍 ") + p.name),
      p.address && h("span.addr", {}, p.address),
      p.phone && h("span.addr", {}, "📞 " + p.phone),
      p.lat == null && h("span.addr", {}, "Not on the map yet — tell the assistant its address."),
      !p.isHome && p.driveMinutes != null && h("span.addr", {}, `🚗 ${p.driveMinutes} min from home`),
      next && h("span.next", {}, `Next: ${next.event.title}${next.event.who?.length ? " (" + next.event.who.join(", ") + ")" : ""} · ${dayFmt(next.date)} ${timeRange(next)}`),
      p.notes && h("span.addr", {}, p.notes),
      placeButtons(p, { mapLink: false }));
  }) : [h("div.empty", {}, "No places yet. When the assistant adds an activity, its place shows up here.")]));

  // The map itself.
  try {
    const L = await loadLeaflet();
    if (!leaflet) {
      const map = L.map("map", { zoomControl: true, attributionControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      leaflet = { L, map, layer: L.layerGroup().addTo(map), markers: new Map() };
      map.setView([40.35, -74.66], 11);
    }
    const { map, layer, markers } = leaflet;
    map.invalidateSize();
    layer.clearLayers();
    markers.clear();
    const pinned = places.filter((p) => p.lat != null);
    for (const p of pinned) {
      const icon = L.divIcon({
        className: "",
        html: `<div style="font-size:${soon.has(p.id) || p.isHome ? 30 : 24}px;line-height:1;transform:translate(-50%,-90%);filter:drop-shadow(0 2px 2px rgba(0,0,0,.3))${soon.has(p.id) || p.isHome ? "" : ";opacity:.7"}">${p.isHome ? "🏠" : "📍"}</div>`,
        iconSize: [0, 0],
      });
      const next = nextAt(p.id);
      const pop = h("div", {},
        h("b", {}, p.name),
        p.address && h("div", {}, p.address),
        next && h("div", {}, `Next: ${next.event.title} · ${dayFmt(next.date)} ${timeRange(next)}`),
        placeButtons(p, { mapLink: false }));
      const mk = L.marker([p.lat, p.lng], { icon, title: p.name }).bindPopup(pop).addTo(layer);
      mk.on("click", () => document.getElementById("place-" + p.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      markers.set(p.id, mk);
    }
    const focus = state.focusPlace && placeById(state.focusPlace);
    if (focus?.lat != null) {
      map.setView([focus.lat, focus.lng], 15);
      markers.get(focus.id)?.openPopup();
      document.getElementById("place-" + focus.id)?.scrollIntoView({ block: "nearest" });
    } else if (pinned.length === 1) {
      map.setView([pinned[0].lat, pinned[0].lng], 14);
    } else if (pinned.length > 1) {
      map.fitBounds(L.latLngBounds(pinned.map((p) => [p.lat, p.lng])), { padding: [36, 36], maxZoom: 15 });
    }
  } catch (e) {
    console.error(e);
    // Keep a map that already works; only a failed load gets the message.
    if (!leaflet) $("map").replaceChildren(h("div.empty", {}, "The map couldn't load. The places below still have Navigate buttons."));
  }
}

/* ----------------------------------------------------------------- memory */

const ACTIONS = {
  "event.create": "📅 added", "event.update": "📅 changed", "event.delete": "📅 removed",
  "event.skip_occurrence": "📅 cancelled a date of", "event.restore_occurrence": "📅 restored a date of",
  "place.create": "📍 saved", "place.update": "📍 updated", "place.delete": "📍 removed",
  "memory.add": "🧠 remembered", "memory.update": "🧠 updated", "memory.forget": "🧠 forgot",
};
function auditText(a) {
  const x = a.after || a.before || {};
  const label = x.title || x.name || x.fact || (a.before && (a.before.title || a.before.name || a.before.fact)) || "";
  return `${ACTIONS[a.action] || a.action} ${label ? "“" + label + "”" : ""}`;
}

function renderMemory() {
  const view = $("view-memory");
  if (view.hidden) return;
  const body = $("memory-body");
  body.replaceChildren(
    h("h3", {}, "What the assistant remembers"),
    h("p.lead", {}, "These facts are visible to the whole family. To fix or forget something, ask: “/forget …” or “/that's wrong, …”."),
    h("div.stats", {},
      h("span.stat", {}, h("b", {}, String(state.memory.length)), "facts"),
      h("span.stat", {}, h("b", {}, String(state.places.length)), "places"),
      h("span.stat", {}, h("b", {}, String(state.events.length)), "calendar events"),
      h("button.btn.primary", { type: "button", onclick: () => exportJson() }, "⬇ Download JSON")),
    state.memory.length
      ? h("ul", {}, ...state.memory.map((m) => h("li", {},
        h("div", {}, m.fact),
        h("div.sub", {}, [m.subject && `about ${m.subject}`, `from ${m.saidBy || m.createdBy || "?"}`, stampText(m.createdAt), m.updatedBy && `updated by ${m.updatedBy}`].filter(Boolean).join(" · ")))))
      : h("p.lead", {}, "Nothing yet. Tell the assistant things like “Maria is 8 and does ballet” and they'll show up here."),
    state.myMemory.length > 0 && h("h3", {}, "🔒 Only you can see"),
    state.myMemory.length > 0 && h("p.lead", {}, "Remembered from your private conversation with the assistant. Ask it there to change or forget any of these."),
    state.myMemory.length > 0 && h("ul", {}, ...state.myMemory.map((m) => h("li", {},
      h("div", {}, m.fact),
      h("div.sub", {}, [m.subject && `about ${m.subject}`, stampText(m.createdAt)].filter(Boolean).join(" · "))))),
    h("h3", {}, "Recent changes"),
    state.audit.length
      ? h("ul", {}, ...state.audit.map((a) => h("li", {},
        h("div", {}, auditText(a)),
        h("div.sub", {}, `${a.by || "?"} · ${stampText(a.createdAt)}${a.request ? ` · asked: “${a.request.length > 90 ? a.request.slice(0, 89) + "…" : a.request}”` : a.via === "private" ? " · asked privately" : ""}`))))
      : h("p.lead", {}, "No changes yet."),
  );
}

/** Downloads everything the assistant knows, plus its full change log. */
async function exportJson() {
  const plain = (v) => {
    if (v?.toDate) return v.toDate().toISOString();
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
    return v;
  };
  const all = async (name, q) => (await getDocs(q || collection(db, name))).docs.map((d) => plain({ id: d.id, ...d.data() }));
  try {
    const [memory, places, events, auditLog] = await Promise.all([
      all("memory", query(collection(db, "memory"), orderBy("createdAt"))),
      all("places"),
      all("events"),
      all("auditLog", query(collection(db, "auditLog"), orderBy("createdAt"))),
    ]);
    const data = {
      exportedAt: new Date().toISOString(),
      exportedBy: state.user?.email || null,
      timeZone: FAMILY_TZ,
      memory, places, events, auditLog,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `family-memory-${familyNow().date}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Downloaded family-memory.json");
  } catch (e) {
    console.error(e);
    alert("Couldn't export right now. Please try again.");
  }
}

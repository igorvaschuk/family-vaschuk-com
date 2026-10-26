// In-memory stand-in for the Firebase JS SDK modules (UI tests only).
const ts = (d) => ({ toDate: () => new Date(d) });
const seed = window.__SEED || {};
// This file is served for every Firebase module (app, auth, firestore,
// messaging), so it runs once per module: they all share one store.
const store = window.__store ||= Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
const listeners = window.__listeners ||= [];
let n = 1000;
const fire = (name) => listeners.filter((l) => l.name === name).forEach((l) => l.emit());

export const initializeApp = () => ({});
// auth
const user = { uid: "u-igor", displayName: "Igor Vaschuk", email: "igor@example.com", photoURL: "", getIdToken: async () => "t" };
const auth = { currentUser: user };
export const getAuth = () => auth;
export class GoogleAuthProvider {}
export const onAuthStateChanged = (_a, cb) => setTimeout(() => cb(user), 10);
export const signInWithPopup = async () => {};
export const signOut = async () => {};
// firestore
export const getFirestore = () => ({});
export const collection = (_db, ...path) => ({ name: path.join("/") });
export const doc = (_db, ...path) => ({ name: path.slice(0, -1).join("/"), id: path.at(-1) });
export const orderBy = (field, dir = "asc") => ({ t: "orderBy", field, dir });
export const limit = (n) => ({ t: "limit", n });
export const limitToLast = (n) => ({ t: "limitToLast", n });
export const query = (ref, ...c) => ({ name: ref.name, c });
export const serverTimestamp = () => ts(Date.now());
function rows(q) {
  let list = [...(store[q.name] || [])];
  for (const c of q.c || []) {
    if (c.t === "orderBy") list.sort((a, b) => (a[c.field]?.toDate() - b[c.field]?.toDate()) * (c.dir === "desc" ? -1 : 1));
    if (c.t === "limit") list = list.slice(0, c.n);
    if (c.t === "limitToLast") list = list.slice(-c.n);
  }
  return { docs: list.map(({ id, ...d }) => ({ id, data: () => d })) };
}
export function onSnapshot(q, cb) {
  // A doc ref (it has an id) gets a document snapshot.
  const snapOf = () => {
    const d = (store[q.name] || []).find((x) => x.id === q.id);
    return { exists: () => !!d, data: () => d };
  };
  const l = { name: q.name, emit: () => cb(q.id ? snapOf() : rows(q)) };
  listeners.push(l);
  setTimeout(l.emit, 20);
  return () => listeners.splice(listeners.indexOf(l), 1);
}
export const getDocs = async (q) => rows(q.c ? q : { name: q.name });
// The page checks pending requests over the REST API; answer from the store.
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  // The gcal function: window.__gcal records calls; "start" returns a consent URL.
  const g = String(url).match(/^\/gcal\/(\w+)/);
  if (g) {
    (window.__gcal ||= []).push(g[1]);
    return new Response(JSON.stringify(g[1] === "start" ? { url: "#gcal-consent" } : { ok: true }));
  }
  const m = String(url).match(/firestore\.googleapis\.com\/.*\/documents\/(.+)\/([^/?]+)\?/);
  if (!m) return realFetch(url, opts);
  if (window.__restDown) throw new DOMException("aborted", "AbortError");
  const d = store[m[1]]?.find((x) => x.id === m[2]);
  return new Response(JSON.stringify({ fields: d?.status ? { status: { stringValue: d.status } } : {} }));
};
// Counts reconnects so tests can see the stalled-connection recovery.
export const disableNetwork = async () => { window.__resyncs = (window.__resyncs || 0) + 1; };
// window.__stuck: reconnecting doesn't help (the page should then reload).
export const enableNetwork = async () => { if (!window.__stuck) Object.keys(store).forEach(fire); };
export async function addDoc(ref, data) {
  const id = "m" + n++;
  (store[ref.name] ||= []).push({ id, ...data });
  fire(ref.name);
  window.__onAdd?.(id, data, store, fire, ts);
  return { id };
}
export const setDoc = async () => {};
export const deleteDoc = async () => {};
// Speech recognition: window.__say("words", isFinal) plays a result into the
// running recognizer; window.__mics counts starts.
window.SpeechRecognition = window.webkitSpeechRecognition = class {
  start() {
    window.__mics = (window.__mics || 0) + 1;
    const results = [];
    window.__say = (text, final = true) => {
      if (results.length && !results.at(-1).isFinal) results.pop();
      results.push(Object.assign([{ transcript: text }], { isFinal: final }));
      this.onresult?.({ results });
    };
  }
  stop() { setTimeout(() => this.onend?.(), 0); }
};
// messaging
export const isSupported = async () => false;
export const getMessaging = () => ({});
export const getToken = async () => "t";
export const deleteToken = async () => {};

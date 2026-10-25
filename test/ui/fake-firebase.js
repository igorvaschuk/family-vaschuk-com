// In-memory stand-in for the Firebase JS SDK modules (UI tests only).
const ts = (d) => ({ toDate: () => new Date(d) });
const seed = window.__SEED || {};
const store = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
const listeners = [];
window.__store = store; // tests change "server" data here without notifying listeners
let n = 1000;
const fire = (name) => listeners.filter((l) => l.name === name).forEach((l) => l.emit());

export const initializeApp = () => ({});
// auth
const user = { uid: "u-igor", displayName: "Igor Vaschuk", email: "igor@example.com", photoURL: "" };
const auth = { currentUser: user };
export const getAuth = () => auth;
export class GoogleAuthProvider {}
export const onAuthStateChanged = (_a, cb) => setTimeout(() => cb(user), 10);
export const signInWithPopup = async () => {};
export const signOut = async () => {};
// firestore
export const getFirestore = () => ({});
export const collection = (_db, name) => ({ name });
export const doc = (_db, name, id) => ({ name, id });
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
  const l = { name: q.name, emit: () => cb(rows(q)) };
  listeners.push(l);
  setTimeout(l.emit, 20);
  return () => listeners.splice(listeners.indexOf(l), 1);
}
export const getDocs = async (q) => rows(q.c ? q : { name: q.name });
export async function getDocFromServer(ref) {
  const d = (window.__SERVER || store)[ref.name]?.find((x) => x.id === ref.id);
  return { exists: () => !!d, get: (k) => d?.[k] };
}
// Counts reconnects so tests can see the stalled-connection recovery.
export const disableNetwork = async () => { window.__resyncs = (window.__resyncs || 0) + 1; };
export const enableNetwork = async () => { Object.keys(store).forEach(fire); };
export async function addDoc(ref, data) {
  const id = "m" + n++;
  (store[ref.name] ||= []).push({ id, ...data });
  fire(ref.name);
  window.__onAdd?.(id, data, store, fire, ts);
  return { id };
}
export const setDoc = async () => {};
export const deleteDoc = async () => {};
// messaging
export const isSupported = async () => false;
export const getMessaging = () => ({});
export const getToken = async () => "t";
export const deleteToken = async () => {};

// Firestore adapter for assistant.js and gcal-import.js (both Firebase-free,
// so tests pass in-memory fakes with the same methods).
import { FieldValue } from "firebase-admin/firestore";
import { familyNow } from "./recurrence.js";

export function firestoreStore(db) {
  const stamp = () => FieldValue.serverTimestamp();
  async function recent(coll, n) {
    const snap = await db.collection(coll).orderBy("createdAt", "desc").limit(n).get();
    return snap.docs.reverse().map((d) => {
      const m = d.data();
      return { id: d.id, ...m, createdAt: m.createdAt ? familyNow(m.createdAt.toDate()) : null };
    });
  }
  return {
    /** Up to `limit` docs, oldest first (docs without createdAt are left out). */
    async list(coll, limit) {
      const snap = await db.collection(coll).orderBy("createdAt").limit(limit).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async add(coll, data) {
      const ref = await db.collection(coll).add({ ...data, createdAt: stamp(), updatedAt: stamp() });
      return ref.id;
    },
    /** Creates (or replaces) a doc with a chosen id. */
    async set(coll, id, data) {
      await db.collection(coll).doc(id).set({ ...data, createdAt: stamp(), updatedAt: stamp() });
    },
    /** Patch; keys may be dotted paths ("source.snapshot"). */
    async update(coll, id, patch) {
      await db.collection(coll).doc(id).update({ ...patch, updatedAt: stamp() });
    },
    async del(coll, id) {
      await db.collection(coll).doc(id).delete();
    },
    async get(path) {
      const snap = await db.doc(path).get();
      return snap.exists ? snap.data() : null;
    },
    /** Merges fields into a doc, creating it if needed. */
    async merge(path, data) {
      await db.doc(path).set({ ...data, updatedAt: stamp() }, { merge: true });
    },
    recentMessages: (n) => recent("messages", n),
    recentThread: (uid, n) => recent(`users/${uid}/thread`, n),
  };
}

// Bringing members' own Google Calendar events into the family calendar.
//
// A member picks which of their calendars to look at; the assistant (in
// their private thread) offers what's coming up there, a repeating series as
// one offer, and adds what they choose. Imported events stay linked: when the
// owner moves or cancels one in Google, the family copy follows (follow()).
// Answers can become rules ("always add Masha's appointments") applied to new
// events from then on.
//
// Nothing here imports Firebase: callers pass a `store` (the assistant's
// adapter) and a Calendar API client (gcal.js calendarApi).
//
// Firestore, per member:
//   users/{uid}/settings/gcalImport  { calendars: [{id, name}], rules: [...], nextN, lastAskedAt }
//   users/{uid}/gcalOffers/{key}     one per offered event: { n, title, when, status: new|asked|added|skipped, ... }
// Imported family events have id familyIdFor(...) and
//   source: { type: "gcal", uid, by, calendarId, calendarName, eventId, parentId?, snapshot }
// where snapshot is the Google side as last imported, so only fields changed
// in Google overwrite the family copy (who, notes and the like stay).

import { createHash } from "node:crypto";
import { DAYS, addDays, dateOf, timeOf, familyNow, occurrences, describeRecurrence } from "./recurrence.js";
import { zonedToUtc, CALENDAR_NAME } from "./gcal.js";

export const WINDOW_DAYS = 28;

const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
/** Family event id for an imported Google event: stable, so importing twice updates. */
export const familyIdFor = (uid, calendarId, eventId) => `g_${hash(`${uid}|${calendarId}|${eventId}`)}`;
export const offerKey = (calendarId, eventId) => `${hash(calendarId)}_${hash(eventId)}`;

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const time12 = (t) => {
  const h = +t.slice(0, 2), m = t.slice(3, 5);
  return `${h % 12 || 12}${m === "00" ? "" : ":" + m} ${h < 12 ? "AM" : "PM"}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Wed Oct 28" */
const dayText = (ymd) => `${WEEKDAYS[new Date(ymd + "T12:00:00Z").getUTCDay()]} ${MONTHS[+ymd.slice(5, 7) - 1]} ${+ymd.slice(8, 10)}`;

/* ---------------------------------------------------- Google → family event */

/** A Google start/end ({date} or {dateTime}) as family wall-clock time. */
export function wallTime(t) {
  if (t.date) return { allDay: true, date: t.date, at: t.date };
  const at = familyNow(new Date(t.dateTime)).dateTime;
  return { allDay: false, date: dateOf(at), at };
}

/** An iCalendar date ("20261027", "20261027T183000Z", or local with a TZID) as a family date. */
function icalDate(v, tzid) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return date;
  const time = `${m[4]}:${m[5]}:${m[6]}`;
  const at = m[7] ? new Date(`${date}T${time}Z`) : zonedToUtc(date, time, tzid || undefined);
  return familyNow(at).date;
}

/**
 * Google recurrence lines → { recurrence, exdates, count } in recurrence.js
 * terms, or null when the family calendar can't express the rule (yearly,
 * "second Tuesday", RDATE...). Those are imported occurrence by occurrence.
 */
export function parseRecurrence(lines = []) {
  let rule = null;
  const exdates = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    const head = line.slice(0, i), value = line.slice(i + 1);
    const name = head.split(";")[0].toUpperCase();
    if (name === "RRULE") {
      if (rule) return null;
      rule = Object.fromEntries(value.split(";").map((p) => p.split("=")));
    } else if (name === "EXDATE") {
      const tzid = /TZID=([^;:]+)/.exec(head)?.[1];
      exdates.push(...value.split(",").map((v) => icalDate(v, tzid)).filter(Boolean));
    } else {
      return null;
    }
  }
  if (!rule) return null;
  const freq = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly" }[rule.FREQ];
  if (!freq || Object.keys(rule).some((k) => !["FREQ", "INTERVAL", "BYDAY", "UNTIL", "COUNT", "WKST"].includes(k))) return null;
  const interval = Math.floor(+(rule.INTERVAL || 1));
  if (!(interval >= 1 && interval <= 12)) return null;
  // recurrence.js counts "every N weeks" in Monday-start weeks.
  if (freq === "weekly" && interval > 1 && rule.WKST && rule.WKST !== "MO") return null;
  const recurrence = { freq };
  if (interval > 1) recurrence.interval = interval;
  if (rule.BYDAY) {
    const days = rule.BYDAY.split(",");
    if (freq !== "weekly" || !days.every((d) => DAYS.includes(d))) return null;
    recurrence.byDay = DAYS.filter((d) => days.includes(d));
  }
  if (rule.UNTIL) recurrence.until = icalDate(rule.UNTIL);
  return { recurrence, exdates: [...new Set(exdates)].sort(), count: rule.COUNT ? Math.floor(+rule.COUNT) : null };
}

/**
 * A Google event as family event fields { title, start, end, allDay,
 * recurrence, exdates, location }, or null if its repeat rule can't be
 * expressed (see parseRecurrence).
 */
export function toFamilyEvent(g) {
  const s = wallTime(g.start), e = wallTime(g.end || g.start);
  const allDay = s.allDay;
  // Google all-day ends are exclusive; family ones inclusive.
  let end = allDay ? addDays(e.date, -1) : e.at;
  if (end < s.at) end = s.at;
  const out = {
    title: clip(String(g.summary || "").trim(), 120) || "Busy",
    start: s.at, end, allDay,
    recurrence: null, exdates: [],
    location: g.location ? clip(g.location.trim(), 300) : null,
  };
  if (g.recurrence?.length) {
    const r = parseRecurrence(g.recurrence);
    if (!r) return null;
    out.recurrence = r.recurrence;
    out.exdates = r.exdates;
    if (r.count && !out.recurrence.until) {
      // "10 times" → the date of the 10th occurrence.
      const occ = occurrences({ ...out, id: "x", exdates: [] }, dateOf(out.start), addDays(dateOf(out.start), 800));
      const last = occ[Math.min(r.count, occ.length) - 1];
      if (last) out.recurrence.until = last.date;
    }
  }
  return out;
}

/**
 * A repeating Google event in family terms between two dates, given its
 * occurrences there: dates Google cancelled become skipped dates, and
 * occurrences moved or renamed in Google become one-off exceptions (each
 * keeps its own Google id). Null if the rule can't be expressed.
 */
export function seriesFromGoogle(master, instances, from, to) {
  const base = toFamilyEvent(master);
  if (!base?.recurrence) return null;
  const byOriginal = new Map(instances.map((i) => [wallTime(i.originalStartTime || i.start).date, i]));
  const exdates = new Set(base.exdates);
  const exceptions = [];
  for (const occ of occurrences({ ...base, id: "x", exdates: [] }, from, to)) {
    if (exdates.has(occ.date)) continue;
    const inst = byOriginal.get(occ.date);
    if (!inst) {
      exdates.add(occ.date); // cancelled in Google
      continue;
    }
    const f = toFamilyEvent({ ...inst, recurrence: undefined });
    if (f.start !== occ.start || f.end !== (occ.end || f.end) || f.title !== base.title) {
      exdates.add(occ.date);
      exceptions.push({ eventId: inst.id, data: f });
    }
  }
  return { event: { ...base, exdates: [...exdates].sort() }, exceptions };
}

/** "every Wed, 4 PM, from Wed Oct 28" or "Tue Oct 27, 3 PM" */
export function whenText(f, first = f) {
  const t = f.allDay ? "all day" : time12(timeOf(f.start));
  return f.recurrence ? `${describeRecurrence(f.recurrence)}, ${t}, from ${dayText(dateOf(first.start))}` : `${dayText(dateOf(f.start))}, ${t}`;
}

/**
 * Offers for a calendar's upcoming occurrences: one per series the family
 * calendar can express, otherwise one per occurrence. Events the member
 * declined are left out.
 */
export function buildOffers(calendar, instances, masters) {
  const groups = new Map();
  for (const i of instances) {
    if (i.status === "cancelled" || i.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
    const m = i.recurringEventId && masters.get(i.recurringEventId);
    const series = m && toFamilyEvent(m)?.recurrence ? m : null;
    const eventId = series ? series.id : i.id;
    if (!groups.has(eventId)) groups.set(eventId, { series, first: i });
  }
  return [...groups.entries()].map(([eventId, { series, first }]) => {
    const f = toFamilyEvent(series || { ...first, recurrence: undefined });
    const firstF = toFamilyEvent({ ...first, recurrence: undefined });
    return {
      key: offerKey(calendar.id, eventId),
      calendarId: calendar.id, calendarName: calendar.name,
      eventId, series: !!series,
      title: f.title, when: whenText(f, firstF), first: firstF.start,
    };
  });
}

const ruleMatches = (r, o) => (!r.calendarId || r.calendarId === o.calendarId)
  && (!r.titleContains || o.title.toLowerCase().includes(r.titleContains.toLowerCase()));

/* ------------------------------------------------------------- importer */

class ImportError extends Error {}
export const isImportError = (e) => e instanceof ImportError;
const fail = (msg) => { throw new ImportError(msg); };

/**
 * Import operations for one member. `api` is an async function returning a
 * Calendar API client (it's only built when needed); `audit(action, id,
 * before, after)` logs family changes; summaries of calendar changes are
 * collected in `changes` for the reply and the family-chat notice.
 */
export function importer({ store, api, uid, by, now = familyNow(), audit = async () => {}, log = () => {} }) {
  const settingsPath = `users/${uid}/settings/gcalImport`;
  const offersColl = `users/${uid}/gcalOffers`;
  const changes = [];
  let client = null;
  const cal = async () => (client ||= await api());
  let cache = null; // { settings, offers, events, places }

  async function load() {
    if (cache) return cache;
    const [settings, offers, events, places] = await Promise.all([
      store.get(settingsPath), store.list(offersColl, 1000), store.list("events", 1000), store.list("places", 400),
    ]);
    return (cache = { settings: { calendars: [], rules: [], nextN: 1, ...settings }, offers, events, places });
  }
  const saveSettings = async (patch) => {
    const { settings } = await load();
    Object.assign(settings, patch);
    await store.merge(settingsPath, patch);
  };

  const window = (days = WINDOW_DAYS) => {
    const from = now.date, to = addDays(now.date, days - 1);
    return { from, to, timeMin: zonedToUtc(from, "00:00:00"), timeMax: zonedToUtc(addDays(to, 1), "00:00:00") };
  };

  async function readCalendar(c, w) {
    const api = await cal();
    const instances = (await api.listInstances(c.id, w.timeMin, w.timeMax)).filter((i) => i.status !== "cancelled");
    const masters = new Map();
    for (const id of new Set(instances.map((i) => i.recurringEventId).filter(Boolean))) {
      const m = await api.getEvent(c.id, id);
      if (m) masters.set(id, m);
    }
    return { instances, masters };
  }

  /** Writes (or refreshes) one imported family event; returns what happened. */
  async function upsertFamily({ calendarId, calendarName, eventId, parentId = null }, data, { who, from } = {}) {
    const { events, places } = await load();
    const id = familyIdFor(uid, calendarId, eventId);
    const place = data.location ? matchPlaceLoose(places, data.location) : null;
    const loc = { placeId: place?.id || null, location: place ? place.name : data.location };
    const existing = events.find((e) => e.id === id);
    if (!existing) {
      const doc = {
        title: data.title, start: data.start, end: data.end, allDay: data.allDay,
        recurrence: data.recurrence, exdates: data.exdates, ...loc,
        who: who || [], notes: null, remind: true,
        createdBy: by, updatedBy: by,
        source: { type: "gcal", uid, by, calendarId, calendarName, eventId, parentId, snapshot: data },
      };
      await store.set("events", id, doc);
      events.push({ id, ...doc });
      await audit("event.import", id, null, doc);
      changes.push({ kind: "event", id, summary: `added “${data.title}”${who?.length ? " for " + who.join(" & ") : ""} from ${by}'s calendar (${whenText(data)})` });
      return "added";
    }
    const snap = existing.source?.snapshot || {};
    const same = (k) => JSON.stringify(snap[k] ?? null) === JSON.stringify(data[k] ?? null);
    const patch = {};
    for (const k of ["title", "start", "end", "allDay", "recurrence"]) if (!same(k)) patch[k] = data[k];
    if (!same("location")) Object.assign(patch, loc);
    // Skipped dates before the window were worked out earlier; keep them.
    const exdates = [...new Set([...(data.exdates || []), ...(existing.exdates || []).filter((d) => from && d < from)])].sort();
    if (JSON.stringify(exdates) !== JSON.stringify(existing.exdates || [])) patch.exdates = exdates;
    if (who?.length && JSON.stringify(who) !== JSON.stringify(existing.who || [])) patch.who = who;
    if (!Object.keys(patch).length) {
      if (JSON.stringify(snap) !== JSON.stringify(data)) await store.update("events", id, { "source.snapshot": data });
      return "same";
    }
    const { id: _, ...before } = existing;
    await store.update("events", id, { ...patch, updatedBy: by, "source.snapshot": data });
    Object.assign(existing, patch, { source: { ...existing.source, snapshot: data } });
    await audit("event.sync", id, before, patch);
    const only = Object.keys(patch).every((k) => k === "exdates" || k === "who");
    changes.push({ kind: "event", id, summary: only && patch.exdates ? `updated skipped dates of “${existing.title}” from ${by}'s calendar` : `changed “${existing.title}” from ${by}'s calendar (${whenText(existing)})` });
    return "changed";
  }

  async function removeFamily(e, why) {
    const { events } = await load();
    const { id, ...before } = e;
    await store.del("events", id);
    events.splice(events.indexOf(e), 1);
    await audit("event.unimport", id, before, { reason: why });
    changes.push({ kind: "event", id, summary: `removed “${e.title}” (${why})` });
  }

  /** Imports a series with its exceptions in the window, or one occurrence. */
  async function importEvent(o, { who, w = window() } = {}) {
    const api = await cal();
    if (o.series) {
      const master = await api.getEvent(o.calendarId, o.eventId);
      if (!master) fail(`“${o.title}” isn't in ${by}'s calendar anymore`);
      const instances = (await api.listInstances(o.calendarId, w.timeMin, w.timeMax)).filter((i) => i.recurringEventId === master.id && i.status !== "cancelled");
      const s = seriesFromGoogle(master, instances, w.from, w.to) || fail(`“${o.title}” repeats in a way the family calendar can't show`);
      const result = await upsertFamily(o, s.event, { who, from: w.from });
      await syncExceptions(o, s.exceptions, { who, from: w.from });
      return result;
    }
    const ev = await api.getEvent(o.calendarId, o.eventId);
    if (!ev) fail(`“${o.title}” isn't in ${by}'s calendar anymore`);
    return upsertFamily(o, toFamilyEvent({ ...ev, recurrence: undefined }), { who });
  }

  /** Moved/renamed occurrences of a series as their own linked events; stale future ones go. */
  async function syncExceptions(o, exceptions, { who, from }) {
    const { events } = await load();
    const parent = { ...o, parentId: o.eventId };
    // A moved occurrence is for the same people as its series.
    const series = events.find((e) => e.id === familyIdFor(uid, o.calendarId, o.eventId));
    const forWho = who?.length ? who : series?.who;
    for (const x of exceptions) await upsertFamily({ ...parent, eventId: x.eventId }, x.data, { who: forWho, from });
    const keep = new Set(exceptions.map((x) => familyIdFor(uid, o.calendarId, x.eventId)));
    for (const e of events.filter((e) => e.source?.uid === uid && e.source.parentId === o.eventId && !keep.has(e.id) && dateOf(e.start) >= from)) {
      await removeFamily(e, `moved back or cancelled in ${by}'s calendar`);
    }
  }

  const pending = (offers) => offers.filter((o) => o.status === "new" || o.status === "asked").sort((a, b) => (a.first < b.first ? -1 : 1));
  const brief = (o) => ({ n: o.n, title: o.title, when: o.when, calendar: o.calendarName, repeats: !!o.series });

  /**
   * Refreshes the offers from the chosen calendars: new events become offers
   * (numbered), rules decide what they can. Returns the offers still waiting
   * for an answer.
   */
  async function refreshOffers(days = WINDOW_DAYS) {
    const st = await load();
    if (!st.settings.calendars.length) fail("no calendars chosen yet: ask which of their calendars to look at (my_google_calendars, then choose_import_calendars)");
    const w = window(days);
    const byKey = new Map(st.offers.map((o) => [o.id, o]));
    const fresh = [];
    for (const c of st.settings.calendars) {
      let read;
      try {
        read = await readCalendar(c, w);
      } catch (e) {
        if (e.status === 404) { log(`calendar ${c.name} is gone`); continue; }
        throw e;
      }
      for (const o of buildOffers(c, read.instances, read.masters)) {
        const old = byKey.get(o.key);
        if (old) {
          if (old.title !== o.title || old.when !== o.when) {
            await store.update(offersColl, o.key, { title: o.title, when: o.when, first: o.first });
            Object.assign(old, { title: o.title, when: o.when, first: o.first });
          }
          continue;
        }
        if (!fresh.some((f) => f.key === o.key)) fresh.push(o);
      }
    }
    // Number new offers in date order, so a list reads top to bottom.
    fresh.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
    for (const o of fresh) {
      const offer = { ...o, n: st.settings.nextN, status: "new", firstSeen: now.date };
      await saveSettings({ nextN: st.settings.nextN + 1 });
      const { key, ...doc } = offer;
      await store.set(offersColl, key, doc);
      const row = { id: key, ...doc };
      st.offers.push(row);
      byKey.set(key, row);
      const rule = st.settings.rules.find((r) => ruleMatches(r, row));
      try {
        if (rule?.decision === "add") await decide(row, "add", { w });
        else if (rule?.decision === "skip") await decide(row, "skip");
      } catch (e) {
        if (!isImportError(e)) throw e;
        log(`rule ${rule.id} couldn't add “${row.title}”: ${e.message}`); // stays waiting for an answer
      }
    }
    return pending(st.offers);
  }

  async function decide(o, decision, { who, w } = {}) {
    if (decision === "add") {
      await importEvent(o, { who, w });
      await store.update(offersColl, o.id, { status: "added" });
      o.status = "added";
    } else {
      await store.update(offersColl, o.id, { status: "skipped" });
      o.status = "skipped";
    }
  }

  const byNumbers = async (numbers) => {
    const { offers } = await load();
    return numbers.map((n) => offers.find((o) => o.n === Number(n)) || fail(`no offer number ${n}; check the calendar again for current numbers`));
  };

  return {
    changes,
    /** The member's Google calendars, marking the chosen ones (not the app's own). */
    async calendars() {
      const st = await load();
      const all = (await (await cal()).listCalendars()).filter((c) => c.name !== CALENDAR_NAME);
      const chosen = new Set(st.settings.calendars.map((c) => c.id));
      return all.map((c) => ({ ...c, chosen: chosen.has(c.id) }));
    },
    async chooseCalendars(ids) {
      const all = await this.calendars();
      const picked = ids.map((id) => all.find((c) => c.id === id || c.name.toLowerCase() === String(id).toLowerCase()) || fail(`no calendar “${id}”; call my_google_calendars for the list`));
      await saveSettings({ calendars: picked.map((c) => ({ id: c.id, name: c.name })) });
      return picked.map((c) => c.name);
    },
    /** Offers waiting for an answer (after refreshing them), marked as asked. */
    async check(days) {
      const list = await refreshOffers(days);
      for (const o of list.filter((o) => o.status === "new")) {
        await store.update(offersColl, o.id, { status: "asked" });
        o.status = "asked";
      }
      return list.map(brief);
    },
    async add(items) {
      const out = [];
      for (const { n, who } of items) {
        const [o] = await byNumbers([n]);
        if (o.status === "added") { out.push({ n, title: o.title, note: "already added" }); continue; }
        await decide(o, "add", { who });
        out.push({ n, title: o.title, added: true });
      }
      return out;
    },
    async skip(numbers) {
      for (const o of await byNumbers(numbers)) if (o.status !== "added") await decide(o, "skip");
      return { ok: true };
    },
    async addRule({ decision, calendar, titleContains, note }) {
      const st = await load();
      if (!["add", "skip"].includes(decision)) fail("decision must be add or skip");
      const c = calendar ? st.settings.calendars.find((x) => x.id === calendar || x.name.toLowerCase() === String(calendar).toLowerCase()) || fail(`“${calendar}” isn't one of the chosen calendars`) : null;
      if (!c && !titleContains) fail("a rule needs a calendar, words in the title, or both");
      const rule = { id: "r" + st.settings.nextN, decision, calendarId: c?.id || null, calendarName: c?.name || null, titleContains: titleContains || null, note: clip(note || "", 200) };
      await saveSettings({ rules: [...st.settings.rules, rule], nextN: st.settings.nextN + 1 });
      return rule;
    },
    async removeRule(id) {
      const st = await load();
      if (!st.settings.rules.some((r) => r.id === id)) fail(`no rule ${id}`);
      await saveSettings({ rules: st.settings.rules.filter((r) => r.id !== id) });
      return { ok: true };
    },
    /** Settings and waiting offers, for the assistant's prompt (no Google calls). */
    async state() {
      const st = await load();
      return { calendars: st.settings.calendars, rules: st.settings.rules, waiting: pending(st.offers).map(brief), lastAskedAt: st.settings.lastAskedAt || null };
    },
    refreshOffers,
    saveSettings,

    /** Brings every linked family event in line with the owner's Google Calendar. */
    async follow() {
      const st = await load();
      const w = window();
      const mine = st.events.filter((e) => e.source?.type === "gcal" && e.source.uid === uid);
      const api = await cal();
      for (const e of mine.filter((e) => !e.source.parentId)) {
        if (!st.events.includes(e)) continue;
        const o = e.source;
        const master = await api.getEvent(o.calendarId, o.eventId);
        if (!master) {
          for (const x of st.events.filter((x) => x.source?.uid === uid && x.source.parentId === o.eventId)) await removeFamily(x, `cancelled in ${by}'s calendar`);
          await removeFamily(e, `deleted in ${by}'s calendar`);
          continue;
        }
        if (e.recurrence || master.recurrence) {
          const instances = (await api.listInstances(o.calendarId, w.timeMin, w.timeMax)).filter((i) => i.recurringEventId === master.id && i.status !== "cancelled");
          const s = seriesFromGoogle(master, instances, w.from, w.to);
          if (!s) continue; // the rule became something the family calendar can't show; leave it
          await upsertFamily(o, s.event, { from: w.from });
          await syncExceptions(o, s.exceptions, { from: w.from });
        } else {
          if (dateOf(e.end || e.start) < addDays(now.date, -1)) continue; // past one-offs stay as they were
          await upsertFamily(o, toFamilyEvent({ ...master, recurrence: undefined }));
        }
      }
    },
  };
}

/** A saved place whose name (or alias) appears at the start of a Google location. */
function matchPlaceLoose(places, location) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const loc = norm(location);
  return places.find((p) => [p.name, ...(p.aliases || [])].map(norm).some((n) => n.length > 3 && (loc === n || loc.startsWith(n + " "))))
    || places.find((p) => p.address && loc.includes(norm(p.address)))
    || null;
}

/** The daily question in a member's private thread about events still waiting. */
export function digestText(waiting) {
  const lines = waiting.slice(0, 15).map((o) => `${o.n}. ${o.title} — ${o.when}${o.calendar ? ` (${o.calendar})` : ""}`);
  const more = waiting.length > 15 ? `\n…and ${waiting.length - 15} more.` : "";
  return `I found ${waiting.length === 1 ? "a new event" : `${waiting.length} new events`} in your Google Calendar:\n${lines.join("\n")}${more}\n\nAdd any of them to the family calendar? Say “all”, “none”, or which numbers (and who they're for).`;
}

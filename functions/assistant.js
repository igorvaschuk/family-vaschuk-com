// The family assistant: turns a chat request into Claude tool calls against
// the family calendar (events), saved places, and memory.
//
// Requests come from three places: the family chat ("/..."), the shared
// assistant tab, and each member's private thread (users/{uid}/thread).
// A private request also sees that member's private memory
// (users/{uid}/memory) and thread; nothing private goes into the family's
// collections except calendar/place changes, which are shared by nature.
//
// Nothing here imports Firebase. index.js passes in a small `store` adapter,
// a `callClaude` function, a `geocode` function and a `route` function
// (driving minutes between two points), so tests can use fakes.

import {
  FAMILY_TZ, DAYS, familyNow, agenda, addDays, isDate, isDateTime, dateOf, timeOf,
  describeRecurrence, directionsUrl,
} from "./recurrence.js";

export const ASSISTANT = { uid: "assistant", name: "Family Assistant" };
const MAX_STEPS = 10;
const LIMITS = { memory: 400, places: 300, events: 400, chat: 30 };

/** The request text if this message is for the assistant, else null. */
export function requestText(msg) {
  if (!msg || msg.uid === ASSISTANT.uid || msg.kind) return null;
  const text = String(msg.text || "").trim();
  if (msg.channel === "assistant" || msg.channel === "private") return text.replace(/^\/\s*/, "");
  if (text.startsWith("/")) return text.slice(1).trim();
  return null;
}

/* ------------------------------------------------------------------ prompt */

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const time12 = (t) => {
  if (!t) return "";
  const h = +t.slice(0, 2), m = t.slice(3, 5);
  return `${h % 12 || 12}${m === "00" ? "" : ":" + m} ${h < 12 ? "AM" : "PM"}`;
};

function eventLine(e, placesById) {
  const place = e.placeId && placesById.get(e.placeId);
  const when = e.allDay || !timeOf(e.start)
    ? `${dateOf(e.start)}${e.end && dateOf(e.end) !== dateOf(e.start) ? "–" + dateOf(e.end) : ""} (all day)`
    : `${e.start}–${e.end ? timeOf(e.end) : "?"}`;
  return [
    `${e.id}: ${e.title}`,
    e.who?.length ? `who: ${e.who.join(", ")}` : "",
    `${e.recurrence ? "first " : ""}${when}`,
    e.recurrence ? `repeats ${describeRecurrence(e.recurrence)} ${JSON.stringify(e.recurrence)}` : "",
    e.exdates?.length ? `skipped: ${e.exdates.join(", ")}` : "",
    place ? `at place ${place.id} (${place.name})` : e.location ? `at "${e.location}" (not on map)` : "",
    e.notes ? `notes: ${clip(e.notes, 200)}` : "",
    e.remind === false ? "reminders off" : "",
  ].filter(Boolean).join(" | ");
}

export const REMINDER_BUFFER_MIN = 10;
export const DEFAULT_DRIVE_MIN = 20;

const WHERE = {
  family: "from the family chat (everyone sees your answer)",
  assistant: "from the shared assistant tab (the whole family can read it)",
  private: "in their private thread with you: only they see it",
};

/** What the assistant knows about the requester's Google Calendar link (private thread only). */
function gcalLine(requester, gcal) {
  if (gcal?.state === "connected" || gcal?.state === "syncing") {
    return `${requester}'s Google Calendar is connected (${gcal.email || "their Google account"}): every family calendar event is copied automatically into a "Vaschuk Family" calendar there, so nothing needs doing per event. Changes must be made here, in the family calendar; edits made in Google are overwritten.`;
  }
  if (gcal?.state === "error") return `${requester}'s Google Calendar link has a problem: ${gcal.error || "unknown"}. The card at the top of this conversation has a Reconnect button.`;
  return `${requester} hasn't connected Google Calendar. If they ask about it, tell them to tap "Connect Google Calendar" at the top of this conversation; then every family event appears in a "Vaschuk Family" calendar in their Google Calendar.`;
}

export function buildSystemPrompt({ now, memory, places, events, chat, requester, channel, privateMemory = [], thread = [], gcal = null }) {
  const placesById = new Map(places.map((p) => [p.id, p]));
  const home = places.find((p) => p.isHome);
  const upcoming = agenda(events, now.date, addDays(now.date, 13)).map((o) => {
    const wd = DAYS[new Date(o.date + "T12:00:00Z").getUTCDay()];
    const t = o.allDay ? "all day" : `${time12(timeOf(o.start))}${o.end ? "–" + time12(timeOf(o.end)) : ""}`;
    const place = o.event.placeId && placesById.get(o.event.placeId);
    return `${o.date} ${wd} ${t}: ${o.event.title}${o.event.who?.length ? " (" + o.event.who.join(", ") + ")" : ""}${place ? " @ " + place.name : ""} [${o.id}]`;
  });

  return `You are the Vaschuk family's assistant inside their private family chat (family.vaschuk.com). Your main job is keeping the children's schedule: a shared family calendar of activities, the places those activities happen, and directions to them. You also remember facts the family tells you.

Right now it is ${now.weekday} ${now.date} ${now.time} in the family's time zone (${FAMILY_TZ}). All dates and times you read and write are wall-clock times in that zone.
${requester} is asking ${WHERE[channel] || WHERE.family}.

How to work:
- Make every change with a tool, and only say something is done after the tool succeeded. If a tool returns an error, fix the input and retry, or explain the problem.
- Times: "YYYY-MM-DDTHH:MM" (24h) for timed events, "YYYY-MM-DD" with all_day for all-day ones. If no end time is given, assume 1 hour and say so. Resolve "tomorrow", "next Tuesday" etc. from today's date above.
- Repeating activities (practice every Tue & Thu) are ONE event with a recurrence rule, not many events. Set start to the first occurrence. To cancel a single occurrence use skip_occurrence; to move one, skip it and create a one-off event. "Until the end of the season" with no date: ask, or leave until empty.
- If it's unclear which child, which day, or which event someone means, ask one short question instead of guessing. Small gaps (duration, a missing year) you may fill with a sensible default and mention it.
- Places: reuse a saved place when the name matches (check names and aliases below). For a new place, find the real business before saving it: use web_search (when available) to get its exact name, street address and phone number, searching near the family's home area${home ? ` (home: ${home.address || home.name})` : ""}. Then call save_place with name, address and phone, and create the event with that place_id. If several businesses fit, pick the closest one that matches and mention it ("I picked X on Main St — say if it's a different one"). If nothing turns up, save what you have and ask for the address. Remember useful notes about places (which entrance, parking).
- Read names carefully: in "add Maria's ballet academy tue/thu 6:30-8PM", Maria is most likely a child (check memory) going to a ballet academy, so the event is "Ballet" for Maria at that academy. Without a start date, start at the next matching day; without an end date, it repeats with no until.
- Home: ${home ? `the family's home is saved as ${home.id} (${home.address || home.name}).` : "not saved yet. If someone mentions the home address, save it with save_place and is_home: true; until then drive times can't be computed, so mention once that you'd like the home address for leave-time reminders."}
- "Time to leave" reminders: for every timed event at a place on the map, all family devices with notifications on get a push at (driving time from home + ${REMINDER_BUFFER_MIN} min) before it starts, with a Navigate button. Driving time is computed automatically when a place is saved (without home, ${DEFAULT_DRIVE_MIN} min is assumed). Say the leave-by time when you add an activity. Turn reminders off for an event with remind: false if asked.
- Calling: saved places with a phone number get a Call button in the app; when asked to call a place, make sure its phone is saved and tell them to tap Call.
- Directions: when someone wants to go somewhere or asks for navigation, call get_directions; the app shows an "Open in Google Maps" button, so don't paste URLs.
${channel === "private" ? `- Private thread: what ${requester} says here stays between you and them. Never copy private details into family memory, event notes or the family chat unless they ask. Calendar and place changes are shared by nature: the family sees them and a short notice goes to the family chat, so say so if they seem to expect otherwise.
- Google Calendar: ${gcalLine(requester, gcal)} Bringing their own Google events into the family calendar is coming soon.
- Private memory: remember things only ${requester} needs (their preferences, their own schedule, how they want things done) with remember and private: true. Facts the whole family should know (about the kids, shared plans) go to family memory with private: false; if unsure which, ask.
` : ""}- Memory: when someone states a durable fact (children's names, which child does which activity, coaches and teachers, carpools, preferences, standing arrangements), call remember. Record only what people actually said, attributed to them; never record guesses. If a new fact replaces an old one, use update_memory; if asked to forget, use forget. Family memory is visible to the whole family and is auditable.
${channel === "private" ? "" : `- Google Calendar: each member can copy the family calendar into their own Google Calendar from the Assistant tab → Just me → Connect Google Calendar.
`}- If asked for a JSON / export / dump of what you remember, call export_memory and give a one-line summary.
- Replies are read on phones: short, plain text, no markdown (no **bold**, headings or tables). Use "•" lines for lists. Times like "5:30 PM", dates like "Tue Oct 27".

${channel === "private" ? `PRIVATE MEMORY (only ${requester} sees these, ${privateMemory.length} facts):
${privateMemory.map((m) => `${m.id}: ${m.fact}${m.subject ? ` [about ${m.subject}]` : ""} (${m.createdDate || "?"})`).join("\n") || "(nothing yet)"}

` : ""}FAMILY MEMORY (${memory.length} facts):
${memory.map((m) => `${m.id}: ${m.fact}${m.subject ? ` [about ${m.subject}]` : ""} (from ${m.saidBy || m.createdBy || "?"}, ${m.createdDate || "?"})`).join("\n") || "(nothing yet)"}

SAVED PLACES (${places.length}):
${places.map((p) => `${p.id}: ${p.isHome ? "[HOME] " : ""}${p.name}${p.address ? " — " + p.address : ""}${p.lat != null ? ` (${(+p.lat).toFixed(5)},${(+p.lng).toFixed(5)})` : " (not on map)"}${p.phone ? " | phone " + p.phone : ""}${p.driveMinutes != null ? ` | ${p.driveMinutes} min drive from home` : ""}${p.aliases?.length ? " aka " + p.aliases.join(", ") : ""}${p.notes ? " | notes: " + clip(p.notes, 200) : ""}`).join("\n") || "(none yet)"}

CALENDAR EVENTS (${events.length}, as stored):
${events.map((e) => eventLine(e, placesById)).join("\n") || "(none yet)"}

NEXT 14 DAYS (expanded):
${upcoming.join("\n") || "(nothing scheduled)"}

RECENT CHAT (oldest first, for context; "/" lines and "assistant" lines were requests to you):
${chat.join("\n") || "(empty)"}${channel === "private" ? `

PRIVATE THREAD WITH ${requester.toUpperCase()} (oldest first):
${thread.join("\n") || "(empty)"}` : ""}`;
}

/* ------------------------------------------------------------------- tools */

const recurrenceSchema = {
  type: ["object", "null"],
  description: "Omit or null for a one-off event.",
  properties: {
    freq: { type: "string", enum: ["daily", "weekly", "monthly"] },
    interval: { type: "integer", minimum: 1, maximum: 12, description: "Every N days/weeks/months (default 1)." },
    byDay: { type: "array", items: { type: "string", enum: DAYS }, description: "Weekly only: days it happens, e.g. [\"TU\",\"TH\"]." },
    until: { type: ["string", "null"], description: "Last date it can happen, YYYY-MM-DD." },
  },
  required: ["freq"],
};
const eventProps = {
  title: { type: "string", description: "Short activity name, e.g. \"Soccer practice\"." },
  who: { type: "array", items: { type: "string" }, description: "Which children (or family members) it's for." },
  start: { type: "string", description: "YYYY-MM-DDTHH:MM, or YYYY-MM-DD when all_day. For repeating events, the first occurrence." },
  end: { type: ["string", "null"], description: "Same format as start." },
  all_day: { type: "boolean" },
  place_id: { type: ["string", "null"], description: "A saved place id." },
  location: { type: ["string", "null"], description: "Place name and/or address when it isn't saved yet; it gets found on the map and saved." },
  recurrence: recurrenceSchema,
  notes: { type: ["string", "null"], description: "What to bring, who drives, etc." },
  remind: { type: "boolean", description: "Send \"time to leave\" pushes for this event (default true)." },
};
const placeProps = {
  name: { type: "string", description: "The place's real name, e.g. \"Princeton Ballet School\"." },
  address: { type: ["string", "null"], description: "Street address, as complete as known." },
  phone: { type: ["string", "null"], description: "Phone number, e.g. \"(609) 555-0100\"." },
  website: { type: ["string", "null"] },
  lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] },
  aliases: { type: "array", items: { type: "string" }, description: "Other names the family uses for it." },
  notes: { type: ["string", "null"], description: "Parking, entrance, which field…" },
  is_home: { type: "boolean", description: "This is the family's home (origin for drive times)." },
};

export const TOOLS = [
  {
    name: "create_event",
    description: "Add an activity or appointment to the shared family calendar.",
    input_schema: { type: "object", properties: eventProps, required: ["title", "start"] },
  },
  {
    name: "update_event",
    description: "Change an existing calendar event. Pass only fields that change; null clears a field. Changing a repeating event changes all its occurrences.",
    input_schema: { type: "object", properties: { id: { type: "string" }, ...eventProps }, required: ["id"] },
  },
  {
    name: "delete_event",
    description: "Remove an event (and all its occurrences) from the calendar.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "skip_occurrence",
    description: "Cancel one date of a repeating event (e.g. no practice on Thanksgiving). Set restore to undo.",
    input_schema: { type: "object", properties: { id: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, restore: { type: "boolean" } }, required: ["id", "date"] },
  },
  {
    name: "save_place",
    description: "Save a place (activity location, school, a friend's house, home) so it shows on the family map with Navigate and Call buttons. Finds it on the map from the address or name unless lat/lng are given, and works out the driving time from home.",
    input_schema: { type: "object", properties: placeProps, required: ["name"] },
  },
  {
    name: "update_place",
    description: "Change a saved place (fix the address, add a phone number, mark it as home). Changing the address finds it on the map again.",
    input_schema: { type: "object", properties: { id: { type: "string" }, ...placeProps }, required: ["id"] },
  },
  {
    name: "delete_place",
    description: "Remove a saved place. Fails while calendar events still use it unless force is set (then those events keep the place name as text).",
    input_schema: { type: "object", properties: { id: { type: "string" }, force: { type: "boolean" } }, required: ["id"] },
  },
  {
    name: "remember",
    description: "Remember a durable fact the family told you. One fact per call, in a short self-contained sentence, e.g. \"Masha's soccer coach is Mr. Lee (555-0101).\"",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string" },
        subject: { type: ["string", "null"], description: "Who or what it's about, e.g. a child's name or \"carpool\"." },
      },
      required: ["fact"],
    },
  },
  {
    name: "update_memory",
    description: "Replace a remembered fact that changed or was wrong.",
    input_schema: { type: "object", properties: { id: { type: "string" }, fact: { type: "string" }, subject: { type: ["string", "null"] } }, required: ["id", "fact"] },
  },
  {
    name: "forget",
    description: "Delete a remembered fact when asked to forget it or it's no longer true.",
    input_schema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_directions",
    description: "Give the family a Google Maps navigation button to a saved place (preferred) or any destination text.",
    input_schema: {
      type: "object",
      properties: {
        place_id: { type: ["string", "null"] },
        destination: { type: ["string", "null"], description: "Address or place name, when it's not a saved place." },
        mode: { type: "string", enum: ["driving", "walking", "transit", "bicycling"] },
      },
    },
  },
  {
    name: "export_memory",
    description: "Give the family a button that downloads everything you remember (facts, places, calendar, change log) as JSON.",
    input_schema: { type: "object", properties: {} },
  },
];

/** TOOLS, plus the private-memory switch in a member's private thread. */
export function toolsFor(channel) {
  if (channel !== "private") return TOOLS;
  return TOOLS.map((t) => t.name !== "remember" ? t : {
    ...t,
    input_schema: {
      ...t.input_schema,
      properties: {
        ...t.input_schema.properties,
        private: { type: "boolean", description: "true (default here): only the person asking can see it. false: family memory, visible to everyone." },
      },
    },
  });
}

/* --------------------------------------------------------- tool execution */

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };
const str = (v, max, field) => {
  if (v == null) return null;
  if (typeof v !== "string") fail(`${field} must be text`);
  v = v.trim();
  if (v.length > max) fail(`${field} is too long (max ${max})`);
  return v || null;
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function cleanRecurrence(r) {
  if (r == null) return null;
  if (typeof r !== "object") fail("recurrence must be an object");
  if (!["daily", "weekly", "monthly"].includes(r.freq)) fail("recurrence.freq must be daily, weekly or monthly");
  const out = { freq: r.freq };
  if (r.interval != null) {
    const n = Math.floor(+r.interval);
    if (!(n >= 1 && n <= 12)) fail("recurrence.interval must be 1–12");
    if (n > 1) out.interval = n;
  }
  if (r.byDay?.length) {
    if (r.freq !== "weekly") fail("byDay only applies to weekly events");
    const days = [...new Set(r.byDay.map((d) => String(d).toUpperCase().slice(0, 2)))];
    if (!days.every((d) => DAYS.includes(d))) fail("byDay values must be SU, MO, TU, WE, TH, FR, SA");
    out.byDay = DAYS.filter((d) => days.includes(d));
  }
  if (r.until != null) {
    if (!isDate(r.until)) fail("recurrence.until must be YYYY-MM-DD");
    out.until = r.until;
  }
  return out;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A saved place whose name or alias matches the text, if any. */
export function matchPlace(places, text) {
  const t = norm(text);
  if (!t) return null;
  const names = (p) => [p.name, ...(p.aliases || [])].map(norm).filter(Boolean);
  return places.find((p) => names(p).includes(t))
    || places.find((p) => names(p).some((n) => n.length > 3 && (t.startsWith(n + " ") || t === n)))
    || places.find((p) => p.address && norm(p.address) === t)
    || null;
}

/**
 * Executes one request end to end. Returns the reply to post:
 * { text, refs: { events, places }, links, changes, familyNotice }.
 */
export async function runRequest({ store, callClaude, geocode, route = async () => null, request, msgId, msg, now = familyNow(), log = () => {} }) {
  const channel = ["assistant", "private"].includes(msg.channel) ? msg.channel : "family";
  const isPrivate = channel === "private";
  const mine = (c) => `users/${msg.uid}/${c}`;
  const [memory, places, events, chatMsgs, privateMemory, threadMsgs, gcal] = await Promise.all([
    store.list("memory", LIMITS.memory),
    store.list("places", LIMITS.places),
    store.list("events", LIMITS.events),
    store.recentMessages(LIMITS.chat + 1),
    isPrivate ? store.list(mine("memory"), LIMITS.memory) : [],
    isPrivate ? store.recentThread(msg.uid, LIMITS.chat + 1) : [],
    isPrivate && store.get ? store.get(mine("settings/gcal")) : null,
  ]);
  const by = msg.name || "Someone";
  const requester = { uid: msg.uid, name: by };
  const refs = { events: new Set(), places: new Set() };
  const links = [];
  const changes = []; // { kind, summary }

  const when = (m) => m.createdAt ? `${m.createdAt.date} ${m.createdAt.time}` : "";
  const chat = chatMsgs.filter((m) => m.id !== msgId).slice(-LIMITS.chat).map((m) => {
    const where = m.uid === ASSISTANT.uid ? "assistant" : m.channel === "assistant" ? "to assistant" : "family chat";
    return `[${when(m)}] ${m.name} (${where}): ${clip(m.text, 400)}`;
  });
  const thread = threadMsgs.filter((m) => m.id !== msgId).slice(-LIMITS.chat)
    .map((m) => `[${when(m)}] ${m.uid === ASSISTANT.uid ? "you" : m.name}: ${clip(m.text, 400)}`);

  const placeById = (id) => places.find((p) => p.id === id) || fail(`no saved place with id ${id}`);
  /** A family fact, or (in a private thread) one of the requester's private facts. */
  const memoryById = (id) => {
    const priv = privateMemory.find((x) => x.id === id);
    if (priv) return { m: priv, list: privateMemory, priv: true };
    const m = memory.find((x) => x.id === id) || fail(`no memory with id ${id}`);
    return { m, list: memory, priv: false };
  };
  const eventById = (id) => events.find((e) => e.id === id) || fail(`no event with id ${id}`);

  // Private requests' words stay private: the family log records the change
  // but not what was asked; changes to private memory are logged privately.
  async function audit(action, targetId, before, after, { priv = false } = {}) {
    await store.add(priv ? mine("auditLog") : "auditLog", {
      action, targetId, before: before ?? null, after: after ?? null,
      by, byUid: msg.uid, requestId: msgId,
      request: isPrivate && !priv ? null : clip(request, 500),
      ...(isPrivate ? { via: "private" } : {}),
    });
  }

  async function findOnMap(query) {
    try {
      return await geocode(query);
    } catch (e) {
      log("geocode failed", query, e.message);
      return null;
    }
  }

  async function driveFromHome(p, home = places.find((x) => x.isHome)) {
    if (!home || home.id === p.id || home.lat == null || p.lat == null) return null;
    try {
      const min = await route(home, p);
      return min == null ? null : Math.max(1, Math.round(min));
    } catch (e) {
      log("route failed", p.name, e.message);
      return null;
    }
  }

  /** Marks one place as home and recomputes every place's drive time from it. */
  async function setHome(home) {
    for (const p of places) {
      const patch = { isHome: p.id === home.id };
      patch.driveMinutes = p.id === home.id ? null : await driveFromHome(p, home);
      if (p.isHome === patch.isHome && p.driveMinutes === patch.driveMinutes) continue;
      await store.update("places", p.id, patch);
      Object.assign(p, patch);
    }
  }

  async function savePlace({ name, address, phone, website, lat, lng, aliases, notes, is_home }) {
    name = str(name, 120, "name") || fail("name is required");
    address = str(address, 300, "address");
    const existing = matchPlace(places, name);
    if (existing) return { place: existing, existed: true };
    let loc = null;
    if (lat != null && lng != null) {
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) fail("lat/lng out of range");
      loc = { lat: +lat, lng: +lng, address: address || null };
    } else {
      loc = await findOnMap(address || name);
    }
    const data = {
      name, address: address || loc?.address || null,
      lat: loc?.lat ?? null, lng: loc?.lng ?? null,
      phone: str(phone, 40, "phone"),
      website: str(website, 300, "website"),
      aliases: (aliases || []).map((a) => str(a, 80, "alias")).filter(Boolean).slice(0, 10),
      notes: str(notes, 1000, "notes"),
      isHome: false,
      driveMinutes: null,
      createdBy: by, updatedBy: by, sourceMessageId: msgId,
    };
    data.driveMinutes = await driveFromHome(data);
    const id = await store.add("places", data);
    const place = { id, ...data };
    places.push(place);
    if (is_home) await setHome(place);
    refs.places.add(id);
    await audit("place.create", id, null, data);
    changes.push({ kind: "place", summary: `saved place “${name}”` });
    return { place, existed: false };
  }

  /** Resolves place_id / location text into { placeId, location }. */
  async function resolveLocation(input, current = {}) {
    if (has(input, "place_id") && input.place_id) {
      const p = placeById(input.place_id);
      return { placeId: p.id, location: p.name, note: null };
    }
    if (has(input, "location")) {
      const text = str(input.location, 300, "location");
      if (!text) return { placeId: null, location: null, note: null };
      const match = matchPlace(places, text);
      if (match) return { placeId: match.id, location: match.name, note: `using saved place ${match.name}` };
      const name = text.split(",")[0].trim();
      const { place } = await savePlace({ name, address: text.includes(",") || /\d/.test(text) ? text : null });
      return {
        placeId: place.id,
        location: place.name,
        note: place.lat == null ? `couldn't find “${text}” on the map; saved it without a pin — ask for the street address (or look it up) and call update_place` : `found on map: ${place.address || place.name}`,
      };
    }
    if (has(input, "place_id")) return { placeId: null, location: null, note: null };
    return { placeId: current.placeId ?? null, location: current.location ?? null, note: null };
  }

  function checkTimes(start, end, allDay) {
    if (allDay) {
      if (!isDate(start)) fail("all-day start must be YYYY-MM-DD");
      if (end && !isDate(end)) fail("all-day end must be YYYY-MM-DD");
    } else {
      if (!isDateTime(start)) fail("start must be YYYY-MM-DDTHH:MM (or set all_day with YYYY-MM-DD)");
      if (end && !isDateTime(end)) fail("end must be YYYY-MM-DDTHH:MM");
    }
    if (end && end < start) fail("end is before start");
  }

  /** "5:42 PM (18 min drive + 10)" for a timed event at a place, else null. */
  const leaveBy = (e) => {
    const p = e.placeId && places.find((x) => x.id === e.placeId);
    if (e.allDay || !p || p.lat == null || e.remind === false) return null;
    const drive = p.driveMinutes ?? DEFAULT_DRIVE_MIN;
    const [h, m] = timeOf(e.start).split(":").map(Number);
    const t = h * 60 + m - drive - REMINDER_BUFFER_MIN;
    const at = time12(`${String(Math.floor(((t % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((t % 60) + 60) % 60).padStart(2, "0")}`);
    return `${at} (${p.driveMinutes != null ? `${drive} min drive from home` : `assumed ${drive} min drive, home not saved`} + ${REMINDER_BUFFER_MIN} min)`;
  };

  const whenText = (e) => {
    const t = e.allDay ? "all day" : time12(timeOf(e.start));
    const day = new Date(dateOf(e.start) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    return e.recurrence ? `${describeRecurrence(e.recurrence)}, ${t}, starting ${day}` : `${day}, ${t}`;
  };

  const tools = {
    async create_event(i) {
      const title = str(i.title, 120, "title") || fail("title is required");
      const allDay = !!i.all_day || isDate(i.start);
      let start = i.start, end = i.end ?? null;
      checkTimes(start, end, allDay);
      if (!allDay && !end) {
        const [h, m] = timeOf(start).split(":").map(Number);
        end = h < 23 ? `${dateOf(start)}T${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}` : `${dateOf(start)}T23:59`;
      }
      const loc = await resolveLocation(i);
      const data = {
        title,
        who: (i.who || []).map((w) => str(w, 60, "who")).filter(Boolean).slice(0, 10),
        start, end, allDay,
        placeId: loc.placeId, location: loc.location,
        recurrence: cleanRecurrence(i.recurrence),
        exdates: [],
        notes: str(i.notes, 1000, "notes"),
        remind: i.remind !== false,
        createdBy: by, updatedBy: by, sourceMessageId: msgId,
      };
      const id = await store.add("events", data);
      events.push({ id, ...data });
      refs.events.add(id);
      if (data.placeId) refs.places.add(data.placeId);
      await audit("event.create", id, null, data);
      changes.push({ kind: "event", summary: `added “${title}”${data.who.length ? " for " + data.who.join(" & ") : ""} (${whenText(data)})` });
      return { ok: true, id, event: data, location_note: loc.note, leave_by: leaveBy(data) };
    },

    async update_event(i) {
      const ev = eventById(i.id);
      const { id, ...before } = ev;
      const patch = {};
      if (has(i, "title")) patch.title = str(i.title, 120, "title") || fail("title can't be empty");
      if (has(i, "who")) patch.who = (i.who || []).map((w) => str(w, 60, "who")).filter(Boolean).slice(0, 10);
      if (has(i, "notes")) patch.notes = str(i.notes, 1000, "notes");
      if (has(i, "recurrence")) patch.recurrence = cleanRecurrence(i.recurrence);
      if (has(i, "remind")) patch.remind = i.remind !== false;
      const allDay = has(i, "all_day") ? !!i.all_day : has(i, "start") ? isDate(i.start) : ev.allDay;
      let start = has(i, "start") ? i.start : ev.start;
      if (allDay && isDateTime(start)) start = dateOf(start);
      let end = has(i, "end") ? i.end ?? null : ev.end;
      if (has(i, "start") && !has(i, "end") && ev.end && !allDay && timeOf(ev.start) && isDateTime(start)) {
        // Keep the same duration when only the start moves.
        const dur = (+timeOf(ev.end).slice(0, 2) * 60 + +timeOf(ev.end).slice(3)) - (+timeOf(ev.start).slice(0, 2) * 60 + +timeOf(ev.start).slice(3));
        const mins = Math.min(23 * 60 + 59, +timeOf(start).slice(0, 2) * 60 + +timeOf(start).slice(3) + Math.max(0, dur));
        end = `${dateOf(start)}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      }
      if (allDay && end && !isDate(end)) end = dateOf(end);
      checkTimes(start, end, allDay);
      Object.assign(patch, { start, end, allDay });
      if (has(i, "place_id") || has(i, "location")) {
        const loc = await resolveLocation(i, ev);
        patch.placeId = loc.placeId;
        patch.location = loc.location;
        patch._note = loc.note;
      }
      const note = patch._note;
      delete patch._note;
      patch.updatedBy = by;
      await store.update("events", id, patch);
      Object.assign(ev, patch);
      refs.events.add(id);
      if (ev.placeId) refs.places.add(ev.placeId);
      await audit("event.update", id, before, patch);
      changes.push({ kind: "event", summary: `changed “${ev.title}” (${whenText(ev)})` });
      return { ok: true, id, event: { ...before, ...patch }, location_note: note || null };
    },

    async delete_event({ id }) {
      const ev = eventById(id);
      const { id: _, ...before } = ev;
      await store.del("events", id);
      events.splice(events.indexOf(ev), 1);
      await audit("event.delete", id, before, null);
      changes.push({ kind: "event", summary: `removed “${ev.title}”` });
      return { ok: true };
    },

    async skip_occurrence({ id, date, restore }) {
      const ev = eventById(id);
      if (!ev.recurrence) fail("that event doesn't repeat; update or delete it instead");
      if (!isDate(date)) fail("date must be YYYY-MM-DD");
      const set = new Set(ev.exdates || []);
      restore ? set.delete(date) : set.add(date);
      const exdates = [...set].sort();
      await store.update("events", id, { exdates, updatedBy: by });
      const before = ev.exdates || [];
      ev.exdates = exdates;
      refs.events.add(id);
      await audit(restore ? "event.restore_occurrence" : "event.skip_occurrence", id, { exdates: before }, { exdates });
      changes.push({ kind: "event", summary: `${restore ? "restored" : "cancelled"} “${ev.title}” on ${date}` });
      return { ok: true, exdates };
    },

    async save_place(i) {
      const { place, existed } = await savePlace(i);
      refs.places.add(place.id);
      return {
        ok: true, id: place.id, already_saved: existed, place,
        note: existed ? "a place with this name was already saved; use update_place to change it"
          : place.lat == null ? "couldn't find it on the map; saved without a pin — ask for the street address (or look it up) and call update_place" : null,
      };
    },

    async update_place(i) {
      const p = placeById(i.id);
      const { id, ...before } = p;
      const patch = {};
      if (has(i, "name")) patch.name = str(i.name, 120, "name") || fail("name can't be empty");
      if (has(i, "aliases")) patch.aliases = (i.aliases || []).map((a) => str(a, 80, "alias")).filter(Boolean).slice(0, 10);
      if (has(i, "notes")) patch.notes = str(i.notes, 1000, "notes");
      if (has(i, "address")) patch.address = str(i.address, 300, "address");
      if (has(i, "phone")) patch.phone = str(i.phone, 40, "phone");
      if (has(i, "website")) patch.website = str(i.website, 300, "website");
      let note = null;
      if (i.lat != null && i.lng != null) {
        if (!(Math.abs(i.lat) <= 90 && Math.abs(i.lng) <= 180)) fail("lat/lng out of range");
        Object.assign(patch, { lat: +i.lat, lng: +i.lng });
      } else if (patch.address) {
        const loc = await findOnMap(patch.address);
        if (loc) Object.assign(patch, { lat: loc.lat, lng: loc.lng });
        else note = "couldn't find that address on the map; the pin didn't move";
      }
      if (has(patch, "lat") && !p.isHome) patch.driveMinutes = await driveFromHome({ ...p, ...patch });
      patch.updatedBy = by;
      await store.update("places", id, patch);
      Object.assign(p, patch);
      if (i.is_home || (p.isHome && has(patch, "lat"))) await setHome(p);
      refs.places.add(id);
      await audit("place.update", id, before, { ...patch, ...(i.is_home ? { isHome: true } : {}) });
      changes.push({ kind: "place", summary: `updated place “${p.name}”` });
      return { ok: true, place: p, note };
    },

    async delete_place({ id, force }) {
      const p = placeById(id);
      const using = events.filter((e) => e.placeId === id);
      if (using.length && !force) fail(`still used by: ${using.map((e) => `${e.id} (${e.title})`).join(", ")}`);
      for (const e of using) {
        await store.update("events", e.id, { placeId: null, location: p.name, updatedBy: by });
        Object.assign(e, { placeId: null, location: p.name });
      }
      const { id: _, ...before } = p;
      await store.del("places", id);
      places.splice(places.indexOf(p), 1);
      await audit("place.delete", id, before, null);
      changes.push({ kind: "place", summary: `removed place “${p.name}”` });
      return { ok: true };
    },

    async remember({ fact, subject, private: priv }) {
      fact = str(fact, 500, "fact") || fail("fact is required");
      priv = isPrivate && priv !== false;
      const list = priv ? privateMemory : memory;
      if (list.some((m) => norm(m.fact) === norm(fact))) return { ok: true, note: "already remembered" };
      const data = { fact, subject: str(subject, 80, "subject"), saidBy: by, saidByUid: msg.uid, createdBy: by, sourceMessageId: msgId, createdDate: now.date };
      const id = await store.add(priv ? mine("memory") : "memory", data);
      list.push({ id, ...data });
      await audit("memory.add", id, null, data, { priv });
      changes.push({ kind: "memory", summary: `remembered${priv ? " privately" : ""}: ${fact}` });
      return { ok: true, id, private: priv };
    },

    async update_memory({ id, fact, subject }) {
      const { m, priv } = memoryById(id);
      const { id: _, ...before } = m;
      const patch = { fact: str(fact, 500, "fact") || fail("fact is required"), updatedBy: by, updatedDate: now.date };
      if (subject !== undefined) patch.subject = str(subject, 80, "subject");
      await store.update(priv ? mine("memory") : "memory", id, patch);
      Object.assign(m, patch);
      await audit("memory.update", id, before, patch, { priv });
      changes.push({ kind: "memory", summary: `updated memory: ${patch.fact}` });
      return { ok: true };
    },

    async forget({ id, reason }) {
      const { m, list, priv } = memoryById(id);
      const { id: _, ...before } = m;
      await store.del(priv ? mine("memory") : "memory", id);
      list.splice(list.indexOf(m), 1);
      await audit("memory.forget", id, before, reason ? { reason: clip(reason, 300) } : null, { priv });
      changes.push({ kind: "memory", summary: `forgot: ${m.fact}` });
      return { ok: true };
    },

    async get_directions({ place_id, destination, mode }) {
      let target;
      if (place_id) {
        target = placeById(place_id);
        refs.places.add(target.id);
      } else {
        const text = str(destination, 300, "destination") || fail("give a place_id or destination");
        target = matchPlace(places, text) || { name: text, address: text };
        if (target.id) refs.places.add(target.id);
      }
      const url = directionsUrl(target, mode || "driving");
      if (!links.some((l) => l.url === url)) links.push({ label: `Navigate to ${target.name}`, url, kind: "directions", placeId: target.id || null });
      return { ok: true, shown_to_family: true };
    },

    async export_memory() {
      if (!links.some((l) => l.kind === "export")) links.push({ label: "Download memory (JSON)", url: "#export", kind: "export" });
      return { ok: true, facts: memory.length, places: places.length, events: events.length };
    },
  };

  async function execTool(name, input) {
    const fn = tools[name];
    if (!fn) return { error: `unknown tool ${name}` };
    try {
      return await fn(input || {});
    } catch (e) {
      if (e instanceof ToolError) return { error: e.message };
      log("tool crashed", name, e);
      return { error: "internal error while running the tool" };
    }
  }

  const system = buildSystemPrompt({ now, memory, places, events, chat, requester: by, channel, privateMemory, thread, gcal });
  const toolList = toolsFor(channel);
  const messages = [{ role: "user", content: `${by}: ${request || "(empty request — briefly say what you can help with)"}` }];
  let text = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await callClaude({ system, messages, tools: toolList });
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    const uses = res.content.filter((b) => b.type === "tool_use");
    if (res.stop_reason === "tool_use" && uses.length) {
      messages.push({ role: "assistant", content: res.content });
      const results = [];
      for (const u of uses) {
        const out = await execTool(u.name, u.input);
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    break;
  }
  if (!text) text = changes.length ? "Done: " + changes.map((c) => c.summary).join("; ") + "." : "Sorry, I got stuck on that one. Could you rephrase it?";

  const calendarChanges = changes.filter((c) => c.kind === "event");
  return {
    text,
    refs: { events: [...refs.events].filter((id) => events.some((e) => e.id === id)), places: [...refs.places].filter((id) => places.some((p) => p.id === id)) },
    links,
    changes: changes.map((c) => c.summary),
    // Calendar changes made outside the family chat (assistant tab or a
    // private thread) are announced there so nobody misses a schedule change.
    familyNotice: (channel !== "family" && calendarChanges.length)
      ? `${by} updated the calendar: ${calendarChanges.map((c) => c.summary).join("; ")}.`
      : null,
  };
}

/* -------------------------------------------------------------- geocoding */

/** Free text → { lat, lng, address } using OpenStreetMap Nominatim, or null. */
export async function nominatimGeocode(query, { fetch = globalThis.fetch, contact = "family.vaschuk.com" } = {}) {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("q", query);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("limit", "1");
  u.searchParams.set("countrycodes", "us");
  const res = await fetch(u, { headers: { "User-Agent": `family-assistant (${contact})`, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const [hit] = await res.json();
  if (!hit) return null;
  const a = hit.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
  const short = [street, town, [a.state, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return { lat: +hit.lat, lng: +hit.lon, address: short || hit.display_name };
}

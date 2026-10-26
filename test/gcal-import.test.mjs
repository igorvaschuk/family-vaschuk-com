import test from "node:test";
import assert from "node:assert/strict";
import { parseRecurrence, toFamilyEvent, seriesFromGoogle, buildOffers, importer, familyIdFor, digestText } from "../functions/gcal-import.js";

test("Google repeat rules → family recurrence, or null when it can't be shown", () => {
  assert.deepEqual(parseRecurrence(["RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TH,TU;UNTIL=20261218T045959Z", "EXDATE;TZID=America/New_York:20261126T183000"]),
    { recurrence: { freq: "weekly", byDay: ["TU", "TH"], until: "2026-12-17" }, exdates: ["2026-11-26"], count: null });
  assert.deepEqual(parseRecurrence(["RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=5"]), { recurrence: { freq: "monthly", interval: 2 }, exdates: [], count: 5 });
  assert.equal(parseRecurrence(["RRULE:FREQ=MONTHLY;BYDAY=2TU"]), null); // "second Tuesday"
  assert.equal(parseRecurrence(["RRULE:FREQ=YEARLY"]), null);
  assert.equal(parseRecurrence(["RRULE:FREQ=WEEKLY", "RDATE:20261101"]), null);
});

test("Google events → family wall-clock events", () => {
  // 22:30Z in October is 6:30 PM in New York.
  assert.deepEqual(toFamilyEvent({ summary: " Dentist ", start: { dateTime: "2026-10-27T22:30:00Z" }, end: { dateTime: "2026-10-27T23:30:00Z" }, location: "Smile Dental, 5 Main St" }),
    { title: "Dentist", start: "2026-10-27T18:30", end: "2026-10-27T19:30", allDay: false, recurrence: null, exdates: [], location: "Smile Dental, 5 Main St" });
  const trip = toFamilyEvent({ summary: "Trip", start: { date: "2026-11-06" }, end: { date: "2026-11-09" } });
  assert.deepEqual([trip.start, trip.end, trip.allDay], ["2026-11-06", "2026-11-08", true]);
  const piano = toFamilyEvent({ summary: "Piano", start: { dateTime: "2026-10-28T16:00:00-04:00" }, end: { dateTime: "2026-10-28T16:45:00-04:00" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"] });
  assert.deepEqual(piano.recurrence, { freq: "weekly", until: "2026-11-11" });
  assert.equal(toFamilyEvent({ summary: "", start: { date: "2026-10-30" }, end: { date: "2026-10-31" } }).title, "Busy");
});

const piano = {
  id: "piano", summary: "Piano", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
  start: { dateTime: "2026-10-28T16:00:00-04:00", timeZone: "America/New_York" }, end: { dateTime: "2026-10-28T16:45:00-04:00", timeZone: "America/New_York" },
};
/** Occurrence of the piano series on a date (optionally moved). */
const pianoOn = (date, { time = "16:00", end = "16:45", off = date < "2026-11-01" ? "-04:00" : "-05:00" } = {}) => ({
  id: `piano_${date.replaceAll("-", "")}`, recurringEventId: "piano", summary: "Piano",
  originalStartTime: { dateTime: `${date}T16:00:00${off}` },
  start: { dateTime: `${date}T${time}:00${off}` }, end: { dateTime: `${date}T${end}:00${off}` },
});

test("a series: cancelled occurrences become skipped dates, moved ones exceptions", () => {
  const s = seriesFromGoogle(piano, [pianoOn("2026-10-28"), pianoOn("2026-11-11", { time: "17:00", end: "17:45" }), pianoOn("2026-11-18")], "2026-10-25", "2026-11-21");
  assert.deepEqual(s.event.exdates, ["2026-11-04", "2026-11-11"]);
  assert.deepEqual(s.exceptions.map((x) => [x.eventId, x.data.start]), [["piano_20261111", "2026-11-11T17:00"]]);
});

test("offers: a series once, one-offs each, declined left out", () => {
  const offers = buildOffers({ id: "cal1", name: "Kids" }, [
    pianoOn("2026-10-28"), pianoOn("2026-11-04"),
    { id: "dent", summary: "Dentist", start: { dateTime: "2026-10-29T15:00:00-04:00" }, end: { dateTime: "2026-10-29T16:00:00-04:00" } },
    { id: "nope", summary: "Work dinner", attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-10-30T19:00:00-04:00" }, end: { dateTime: "2026-10-30T21:00:00-04:00" } },
  ], new Map([["piano", piano]]));
  assert.deepEqual(offers.map((o) => [o.eventId, o.series, o.when]), [
    ["piano", true, "every Wed, 4 PM, from Wed Oct 28"],
    ["dent", false, "Thu Oct 29, 3 PM"],
  ]);
});

/** In-memory stand-ins for the store adapter and the Calendar API. */
function fakeStore(seed = {}) {
  const data = structuredClone(seed);
  const split = (path) => [path.slice(0, path.lastIndexOf("/")), path.slice(path.lastIndexOf("/") + 1)];
  const setPath = (o, k, v) => {
    const keys = k.split(".");
    let t = o;
    for (const key of keys.slice(0, -1)) t = t[key] ||= {};
    t[keys.at(-1)] = structuredClone(v);
  };
  return {
    data,
    async list(c) { return structuredClone(data[c] || []); },
    async add(c, d) { const id = `${c}-${(data[c] ||= []).length + 1}`; data[c].push({ id, ...structuredClone(d) }); return id; },
    async set(c, id, d) { data[c] = (data[c] || []).filter((x) => x.id !== id); data[c].push({ id, ...structuredClone(d) }); },
    async update(c, id, p) { const row = data[c].find((x) => x.id === id); for (const [k, v] of Object.entries(p)) setPath(row, k, v); },
    async del(c, id) { data[c] = data[c].filter((x) => x.id !== id); },
    async get(path) { const [c, id] = split(path); const row = (data[c] || []).find((x) => x.id === id); if (!row) return null; const { id: _, ...rest } = row; return structuredClone(rest); },
    async merge(path, p) { const [c, id] = split(path); let row = (data[c] ||= []).find((x) => x.id === id); if (!row) data[c].push(row = { id }); Object.assign(row, structuredClone(p)); },
  };
}
function fakeCalendar(seed) {
  const events = structuredClone(seed); // tests change these; keep the shared fixtures intact
  const api = {
    events,
    calls: 0,
    async listCalendars() { return [{ id: "primary@x", name: "Igor", primary: true }, { id: "kids@x", name: "Kids" }, { id: "fam@x", name: "Vaschuk Family" }]; },
    async listInstances(cal, tmin, tmax) {
      api.calls++;
      return (events[cal] || []).filter((e) => !e.recurrence).filter((e) => new Date(e.end.dateTime || e.end.date + "T00:00:00-05:00") > tmin && new Date(e.start.dateTime || e.start.date + "T00:00:00-05:00") < tmax);
    },
    async getEvent(cal, id) { return structuredClone((events[cal] || []).find((e) => e.id === id) || null); },
  };
  return api;
}

const now = { date: "2026-10-25", time: "16:00", dateTime: "2026-10-25T16:00", weekday: "SU" };

test("choose calendars, check, add with who, skip, rules, and following Google changes", async () => {
  const store = fakeStore({ places: [{ id: "p1", name: "Smile Dental", address: "5 Main St" }] });
  const google = fakeCalendar({
    "kids@x": [piano, pianoOn("2026-10-28"), pianoOn("2026-11-04"), pianoOn("2026-11-11"), pianoOn("2026-11-18"),
      { id: "dent", summary: "Dentist", location: "Smile Dental, 5 Main St", start: { dateTime: "2026-10-29T15:00:00-04:00" }, end: { dateTime: "2026-10-29T16:00:00-04:00" } }],
    "primary@x": [{ id: "work", summary: "Standup", start: { dateTime: "2026-10-26T09:00:00-04:00" }, end: { dateTime: "2026-10-26T09:15:00-04:00" } }],
  });
  const audits = [];
  const make = () => importer({ store, api: async () => google, uid: "u1", by: "Igor", now, audit: async (a, id) => audits.push([a, id]) });

  let imp = make();
  assert.deepEqual((await imp.calendars()).map((c) => c.name), ["Igor", "Kids"]); // never its own calendar
  assert.deepEqual(await imp.chooseCalendars(["Kids", "primary@x"]), ["Kids", "Igor"]);
  assert.deepEqual(store.data["users/u1/settings"][0].calendars.map((c) => c.name), ["Kids", "your main calendar"]);
  const { waiting, lookingAt } = await imp.check();
  assert.deepEqual(lookingAt, ["Kids", "your main calendar"]);
  assert.deepEqual(waiting.map((o) => [o.n, o.title, o.repeats]), [[1, "Standup", false], [2, "Piano", true], [3, "Dentist", false]]);

  await imp.add([{ n: 2, who: ["Masha"] }, { n: 3, who: ["Dima"] }]);
  await imp.skip([1]);
  const pianoId = familyIdFor("u1", "kids@x", "piano");
  const ev = store.data.events.find((e) => e.id === pianoId);
  assert.deepEqual([ev.title, ev.start, ev.who, ev.recurrence, ev.source.by], ["Piano", "2026-10-28T16:00", ["Masha"], { freq: "weekly", byDay: ["WE"] }, "Igor"]);
  const dent = store.data.events.find((e) => e.title === "Dentist");
  assert.equal(dent.placeId, "p1"); // matched the saved place
  assert.deepEqual(imp.changes.map((c) => c.summary), [
    "added “Piano” for Masha from Igor's calendar (every Wed, 4 PM, from Wed Oct 28)",
    "added “Dentist” for Dima from Igor's calendar (Thu Oct 29, 3 PM)",
  ]);
  assert.deepEqual((await make().state()).waiting, []);

  // A rule: anything from Kids is added from now on.
  imp = make();
  await imp.addRule({ decision: "add", calendar: "Kids", note: "Kids calendar always" });
  google.events["kids@x"].push({ id: "swim", summary: "Swim meet", start: { date: "2026-11-07" }, end: { date: "2026-11-08" } });
  google.events["primary@x"].push({ id: "lunch", summary: "Lunch with Sam", start: { dateTime: "2026-10-30T12:00:00-04:00" }, end: { dateTime: "2026-10-30T13:00:00-04:00" } });
  const left = await imp.refreshOffers();
  assert.deepEqual(left.map((o) => o.title), ["Lunch with Sam"]);
  assert.ok(store.data.events.some((e) => e.title === "Swim meet" && e.allDay));
  assert.match(digestText(left.map((o) => ({ n: o.n, title: o.title, when: o.when, calendar: o.calendarName }))), /^I found a new event in your Google Calendar:\n5\. Lunch with Sam — Fri Oct 30, 12 PM \(your main calendar\)/);

  // Google changes: piano moves to 5 PM, Nov 4 is cancelled, Nov 11 moved to Thursday; dentist deleted.
  const kids = google.events["kids@x"];
  Object.assign(kids[0], { start: { dateTime: "2026-10-28T17:00:00-04:00" }, end: { dateTime: "2026-10-28T17:45:00-04:00" } });
  for (const i of kids.filter((e) => e.recurringEventId === "piano")) {
    i.start.dateTime = i.start.dateTime.replace("T16:00", "T17:00");
    i.end.dateTime = i.end.dateTime.replace("T16:45", "T17:45");
    i.originalStartTime.dateTime = i.originalStartTime.dateTime.replace("T16:00", "T17:00");
  }
  google.events["kids@x"] = kids.filter((e) => e.id !== "piano_20261104" && e.id !== "dent");
  const moved = google.events["kids@x"].find((e) => e.id === "piano_20261111");
  Object.assign(moved, { start: { dateTime: "2026-11-12T17:00:00-05:00" }, end: { dateTime: "2026-11-12T17:45:00-05:00" } });

  imp = make();
  await imp.follow();
  const after = store.data.events.find((e) => e.id === pianoId);
  assert.deepEqual([after.start, after.end, after.who, after.exdates], ["2026-10-28T17:00", "2026-10-28T17:45", ["Masha"], ["2026-11-04", "2026-11-11"]]);
  assert.ok(store.data.events.some((e) => e.source?.parentId === "piano" && e.start === "2026-11-12T17:00" && e.who[0] === "Masha"));
  assert.ok(!store.data.events.some((e) => e.title === "Dentist"));
  assert.deepEqual(imp.changes.map((c) => c.summary), [
    "changed “Piano” from Igor's calendar (every Wed, 5 PM, from Wed Oct 28)",
    "added “Piano” for Masha from Igor's calendar (Thu Nov 12, 5 PM)",
    "removed “Dentist” (deleted in Igor's calendar)",
  ]);
  assert.ok(audits.some(([a]) => a === "event.unimport"));

  // Nothing changed in Google: following again changes nothing.
  imp = make();
  await imp.follow();
  assert.deepEqual(imp.changes, []);
});

test("the private assistant brings events in: check, then add by number with who", async () => {
  const { runRequest } = await import("../functions/assistant.js");
  const store = fakeStore({ "users/u1/settings": [{ id: "gcal", state: "connected", email: "igor@example.com", canImport: true }] });
  Object.assign(store, { recentMessages: async () => [], recentThread: async () => [] });
  const google = fakeCalendar({ "kids@x": [piano, pianoOn("2026-10-28"), pianoOn("2026-11-04")] });
  const steps = [
    [["check_my_google_calendar", {}]],
    [["choose_import_calendars", { calendars: ["Kids"] }], ["check_my_google_calendar", {}]],
    [["add_from_my_calendar", { items: [{ n: 1, who: ["Masha"] }] }]],
  ];
  const seen = [];
  const callClaude = async ({ system, messages, tools }) => {
    seen.push({ system, tools: tools.map((t) => t.name), last: messages.at(-1) });
    const calls = steps.shift();
    if (!calls) return { stop_reason: "end_turn", content: [{ type: "text", text: "Added Piano for Masha." }] };
    return { stop_reason: "tool_use", content: calls.map(([name, input], k) => ({ type: "tool_use", id: `t${seen.length}_${k}`, name, input })) };
  };
  const out = await runRequest({
    store, callClaude, geocode: async () => null, gcal: { canImport: true, api: async () => google },
    request: "bring in the kids calendar", msgId: "t1", msg: { uid: "u1", name: "Igor", channel: "private" }, now,
  });
  assert.ok(seen[0].tools.includes("check_my_google_calendar"));
  assert.match(seen[0].system, /BRINGING IGOR'S OWN EVENTS IN/);
  // Nothing chosen: the first check looks at the main calendar (empty here) without asking.
  const first = JSON.parse(seen[1].last.content[0].content);
  assert.deepEqual([first.looked_at, first.count], [["your main calendar"], 0]);
  const checked = JSON.parse(seen[2].last.content[1].content);
  assert.deepEqual([checked.looked_at, checked.waiting.map((o) => [o.n, o.title, o.repeats])], [["Kids"], [[1, "Piano", true]]]);
  const id = familyIdFor("u1", "kids@x", "piano");
  assert.deepEqual(out.refs.events, [id]);
  assert.equal(store.data.events[0].who[0], "Masha");
  assert.match(out.familyNotice, /^Igor updated the calendar: added “Piano” for Masha from Igor's calendar/);
  // Family log: the import is recorded without the private request's words.
  assert.deepEqual(store.data.auditLog.map((a) => [a.action, a.request, a.via]), [["event.import", null, "private"]]);

  // Not linked for reading: no import tools, and the prompt says how to allow it.
  seen.length = 0;
  store.data["users/u1/settings"][0].canImport = false;
  await runRequest({ store, callClaude, geocode: async () => null, gcal: { canImport: false, api: async () => google }, request: "import my events", msgId: "t2", msg: { uid: "u1", name: "Igor", channel: "private" }, now });
  assert.ok(!seen[0].tools.includes("check_my_google_calendar"));
  assert.match(seen[0].system, /tap "Bring in my events"/);
});

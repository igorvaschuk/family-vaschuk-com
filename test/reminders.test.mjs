import test from "node:test";
import assert from "node:assert/strict";
import { dueReminders, drivingMinutes } from "../functions/reminders.js";
import { runRequest } from "../functions/assistant.js";

const places = [
  { id: "home", name: "Home", isHome: true, lat: 40.30, lng: -74.70 },
  { id: "pb", name: "Princeton Ballet School", address: "301 N Harrison St, Princeton, NJ 08540", phone: "(609) 921-7758", lat: 40.36, lng: -74.65, driveMinutes: 18 },
];
const ballet = { id: "e1", title: "Ballet", who: ["Maria"], start: "2026-10-27T18:30", end: "2026-10-27T20:00", placeId: "pb", recurrence: { freq: "weekly", byDay: ["TU", "TH"] }, exdates: [] };
const at = (date, time) => ({ date, time });

test("reminder fires at drive time + 10 min, once, until the start", () => {
  assert.equal(dueReminders({ events: [ballet], places, now: at("2026-10-27", "18:01") }).length, 0); // 29 min before
  const [r] = dueReminders({ events: [ballet], places, now: at("2026-10-27", "18:02") }); // 28 = 18 + 10
  assert.equal(r.key, "e1_2026-10-27");
  assert.equal(r.title, "🚗 Time to leave for Ballet (Maria)");
  assert.match(r.body, /^Starts 6:30 PM at Princeton Ballet School · ~18 min drive/);
  assert.match(r.url, /google\.com\/maps\/dir\//);
  assert.equal(dueReminders({ events: [ballet], places, now: at("2026-10-27", "18:10"), sent: new Set([r.key]) }).length, 0);
  assert.equal(dueReminders({ events: [ballet], places, now: at("2026-10-27", "18:30") }).length, 0); // started
  assert.equal(dueReminders({ events: [ballet], places, now: at("2026-10-28", "18:05") }).length, 0); // Wednesday
  assert.equal(dueReminders({ events: [{ ...ballet, remind: false }], places, now: at("2026-10-27", "18:10") }).length, 0);
});

test("no home saved: assumes 20 min; events without a mapped place are skipped", () => {
  const noHome = [{ ...places[1], driveMinutes: null }];
  assert.equal(dueReminders({ events: [ballet], places: noHome, now: at("2026-10-27", "17:59") }).length, 0);
  assert.equal(dueReminders({ events: [ballet], places: noHome, now: at("2026-10-27", "18:00") }).length, 1);
  assert.equal(dueReminders({ events: [{ ...ballet, placeId: null }], places, now: at("2026-10-27", "18:10") }).length, 0);
});

test("reminder for an event just after midnight", () => {
  const late = { id: "e2", title: "Airport", start: "2026-10-28T00:15", placeId: "pb", exdates: [] };
  assert.equal(dueReminders({ events: [late], places, now: at("2026-10-27", "23:50") }).length, 1);
});

test("driving minutes: OSRM, else straight-line estimate", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 960 }] }) });
  assert.equal(await drivingMinutes(places[0], places[1], { fetch: ok }), 20);
  const down = async () => { throw new Error("offline"); };
  const est = await drivingMinutes(places[0], places[1], { fetch: down });
  assert.ok(est > 8 && est < 20, String(est));
});

test("UAT: 'add Maria's ballet academy tue/thu 6:30-8PM' — finds the place, phone, drive time, leave-by", async () => {
  const data = { memory: [{ id: "k1", fact: "Maria is our daughter.", saidBy: "Igor" }], places: structuredClone(places.slice(0, 1)), events: [], auditLog: [] };
  let n = 0;
  const store = {
    async list(c) { return structuredClone(data[c]); },
    async add(c, d) { const id = `${c}${++n}`; data[c].push({ id, ...structuredClone(d) }); return id; },
    async update(c, id, p) { Object.assign(data[c].find((x) => x.id === id), structuredClone(p)); },
    async del() {},
    async recentMessages() { return []; },
  };
  const calls = [];
  // What Claude does: web search (server-side, already resolved in content), then our tools.
  const script = [
    { stop_reason: "tool_use", content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "ballet academy near Princeton NJ" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      { type: "tool_use", id: "t1", name: "save_place", input: { name: "Princeton Ballet School", address: "301 N Harrison St, Princeton, NJ 08540", phone: "(609) 921-7758" } },
    ] },
    () => ({ stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t2", name: "create_event", input: { title: "Ballet", who: ["Maria"], start: "2026-10-27T18:30", end: "2026-10-27T20:00", place_id: data.places[1].id, recurrence: { freq: "weekly", byDay: ["TU", "TH"] } } },
    ] }),
    { stop_reason: "end_turn", content: [{ type: "text", text: "Added Ballet for Maria at Princeton Ballet School, Tue & Thu 6:30–8 PM. Leave by 6:02 PM." }] },
  ];
  const callClaude = async ({ messages }) => { calls.push(structuredClone(messages)); const s = script[calls.length - 1]; return typeof s === "function" ? s() : s; };
  const out = await runRequest({
    store, callClaude,
    geocode: async () => ({ lat: 40.36, lng: -74.65, address: "301 N Harrison St, Princeton, NJ 08540" }),
    route: async () => 18,
    request: "add Maria's ballet academy tue/thu 6:30-8PM", msgId: "m1",
    msg: { uid: "u1", name: "Igor", channel: "assistant" },
    now: { date: "2026-10-25", time: "16:10", dateTime: "2026-10-25T16:10", weekday: "SU" },
  });
  const place = data.places[1];
  assert.equal(place.phone, "(609) 921-7758");
  assert.equal(place.driveMinutes, 18);
  const result = JSON.parse(calls[2].at(-1).content[0].content);
  assert.equal(result.leave_by, "6:02 PM (18 min drive from home + 10 min)");
  assert.equal(data.events[0].remind, true);
  assert.deepEqual(out.refs.events, [data.events[0].id]);
  assert.ok(out.familyNotice.startsWith("Igor updated the calendar: added “Ballet” for Maria"));
  // The scheduled job would remind on Tuesday at 6:02 PM.
  assert.equal(dueReminders({ events: data.events, places: data.places, now: { date: "2026-10-27", time: "18:02" } }).length, 1);
});

test("marking home recomputes drive times for saved places", async () => {
  const data = { memory: [], places: [{ id: "p1", name: "Pool", lat: 1, lng: 1, driveMinutes: null }], events: [], auditLog: [] };
  let n = 0;
  const store = {
    async list(c) { return structuredClone(data[c]); },
    async add(c, d) { const id = `${c}${++n}`; data[c].push({ id, ...structuredClone(d) }); return id; },
    async update(c, id, p) { Object.assign(data[c].find((x) => x.id === id), structuredClone(p)); },
    async del() {}, async recentMessages() { return []; },
  };
  let step = 0;
  const callClaude = async () => (step++ === 0
    ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "save_place", input: { name: "Home", address: "12 Elm St", is_home: true } }] }
    : { stop_reason: "end_turn", content: [{ type: "text", text: "Saved home." }] });
  await runRequest({ store, callClaude, geocode: async () => ({ lat: 2, lng: 2, address: "12 Elm St" }), route: async () => 12.4, request: "our home is 12 Elm St", msgId: "m", msg: { uid: "u", name: "Igor" } });
  assert.equal(data.places.find((p) => p.name === "Home").isHome, true);
  assert.equal(data.places.find((p) => p.name === "Pool").driveMinutes, 12);
});

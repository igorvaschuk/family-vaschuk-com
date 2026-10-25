import test from "node:test";
import assert from "node:assert/strict";
import { requestText, runRequest, matchPlace, buildSystemPrompt, TOOLS } from "../functions/assistant.js";

function fakeStore(seed = {}) {
  const data = { memory: [], places: [], events: [], auditLog: [], ...structuredClone(seed) };
  let n = 0;
  return {
    data,
    async list(c) { return structuredClone(data[c] || []); },
    async add(c, d) { const id = `${c}${++n}`; (data[c] ||= []).push({ id, ...structuredClone(d) }); return id; },
    async update(c, id, p) { Object.assign(data[c].find((x) => x.id === id), structuredClone(p)); },
    async del(c, id) { data[c] = data[c].filter((x) => x.id !== id); },
    async recentMessages() { return [{ id: "m0", name: "Olga", text: "Masha has soccer now", createdAt: { date: "2026-10-25", time: "15:00" } }]; },
  };
}

/** A fake Claude that plays a fixed list of tool calls, then a final text. */
function scripted(steps, final) {
  const seen = [];
  let i = 0;
  const fn = async ({ system, messages }) => {
    seen.push({ system, messages: structuredClone(messages) });
    if (i < steps.length) {
      const calls = steps[i++];
      return { stop_reason: "tool_use", content: calls.map(([name, input], k) => ({ type: "tool_use", id: `t${i}_${k}`, name, input })) };
    }
    return { stop_reason: "end_turn", content: [{ type: "text", text: final }] };
  };
  fn.seen = seen;
  return fn;
}

const now = { date: "2026-10-25", time: "16:00", dateTime: "2026-10-25T16:00", weekday: "SU" };
const geocode = async (q) => (/nowhere/i.test(q) ? null : { lat: 40.35, lng: -74.66, address: "1 Lake Rd, Princeton, NJ 08540" });

test("requestText: slash in family chat, anything in assistant tab", () => {
  assert.equal(requestText({ text: "/what's on today", uid: "u" }), "what's on today");
  assert.equal(requestText({ text: "hi all", uid: "u" }), null);
  assert.equal(requestText({ text: "add soccer", uid: "u", channel: "assistant" }), "add soccer");
  assert.equal(requestText({ text: "/add soccer", uid: "u", channel: "assistant" }), "add soccer");
  assert.equal(requestText({ text: "/loop", uid: "assistant" }), null);
  assert.equal(requestText({ text: "/x", uid: "u", kind: "notice" }), null);
});

test("creates a weekly event, saves its place, remembers a fact, gives directions", async () => {
  const store = fakeStore();
  const claude = scripted([
    [["create_event", { title: "Soccer practice", who: ["Masha"], start: "2026-10-27T17:00", location: "Lakeside Park, 1 Lake Rd, Princeton", recurrence: { freq: "weekly", byDay: ["tu", "TH"], until: "2026-12-17" } }],
     ["remember", { fact: "Masha plays soccer on Tuesdays and Thursdays.", subject: "Masha" }]],
    [["get_directions", { destination: "Lakeside Park" }]],
  ], "Added Soccer practice for Masha, Tue & Thu 5 PM at Lakeside Park.");
  const out = await runRequest({ store, callClaude: claude, geocode, request: "Masha soccer Tue/Thu 5pm at Lakeside Park, 1 Lake Rd, Princeton until Dec 17", msgId: "m1", msg: { uid: "u1", name: "Olga", channel: "assistant" }, now });

  const [ev] = store.data.events;
  assert.equal(ev.end, "2026-10-27T18:00"); // default 1 hour
  assert.deepEqual(ev.recurrence, { freq: "weekly", byDay: ["TU", "TH"], until: "2026-12-17" });
  assert.equal(store.data.places[0].name, "Lakeside Park");
  assert.equal(ev.placeId, store.data.places[0].id);
  assert.equal(store.data.memory[0].saidBy, "Olga");
  assert.deepEqual(store.data.auditLog.map((a) => a.action), ["place.create", "event.create", "memory.add"]);
  assert.equal(out.links[0].kind, "directions");
  assert.match(out.links[0].url, /google\.com\/maps\/dir\/.*Lakeside\+Park/);
  assert.deepEqual(out.refs.events, [ev.id]);
  assert.match(out.familyNotice, /^Olga updated the calendar: added “Soccer practice” for Masha \(every Tue & Thu until Dec 17/);
  // Tool results went back to Claude.
  const results = claude.seen[1].messages.at(-1).content;
  assert.equal(results.length, 2);
  assert.ok(!results.some((r) => r.is_error));
});

test("bad input comes back as a tool error, not a crash; family-chat requests post no notice", async () => {
  const store = fakeStore();
  const claude = scripted([[["create_event", { title: "Swim", start: "next tuesday 5pm" }]]], "When exactly?");
  const out = await runRequest({ store, callClaude: claude, geocode, request: "swim next tue", msgId: "m2", msg: { uid: "u1", name: "Igor" }, now });
  const [r] = claude.seen[1].messages.at(-1).content;
  assert.equal(r.is_error, true);
  assert.match(r.content, /YYYY-MM-DDTHH:MM/);
  assert.equal(store.data.events.length, 0);
  assert.equal(out.familyNotice, null);
});

test("update keeps duration, skip occurrence, reuse saved place by alias, forget", async () => {
  const store = fakeStore({
    places: [{ id: "p1", name: "Riverside Pool", aliases: ["the Y"], address: "2 River St", lat: 1, lng: 2 }],
    events: [{ id: "e1", title: "Swim", who: ["Dima"], start: "2026-10-26T16:00", end: "2026-10-26T17:30", allDay: false, placeId: null, recurrence: { freq: "weekly" }, exdates: [] }],
    memory: [{ id: "k1", fact: "Dima swims on Mondays." }],
  });
  const claude = scripted([
    [["update_event", { id: "e1", start: "2026-10-26T16:30", location: "the Y" }],
     ["skip_occurrence", { id: "e1", date: "2026-11-23" }],
     ["forget", { id: "k1", reason: "asked" }],
     ["delete_place", { id: "p1" }]],
  ], "Done.");
  await runRequest({ store, callClaude: claude, geocode, request: "move Dima swim to 4:30 at the Y", msgId: "m3", msg: { uid: "u2", name: "Igor" }, now });
  const ev = store.data.events[0];
  assert.equal(ev.end, "2026-10-26T18:00");
  assert.equal(ev.placeId, "p1");
  assert.deepEqual(ev.exdates, ["2026-11-23"]);
  assert.equal(store.data.memory.length, 0);
  assert.equal(store.data.places.length, 1); // still used by e1 → refused
  const errs = claude.seen[1].messages.at(-1).content.filter((r) => r.is_error);
  assert.equal(errs.length, 1);
  assert.match(errs[0].content, /still used by: e1/);
});

test("place not found on map is saved without a pin and flagged", async () => {
  const store = fakeStore();
  const claude = scripted([[["save_place", { name: "Coach's house", address: "nowhere lane" }]]], "Saved, but I need the address.");
  await runRequest({ store, callClaude: claude, geocode, request: "x", msgId: "m4", msg: { uid: "u", name: "Igor" }, now });
  assert.equal(store.data.places[0].lat, null);
  assert.match(claude.seen[1].messages.at(-1).content[0].content, /couldn't find it on the map/);
});

test("export button and prompt contents", async () => {
  const store = fakeStore({ memory: [{ id: "k1", fact: "Kids are Masha and Dima.", saidBy: "Igor" }] });
  const claude = scripted([[["export_memory", {}]]], "Here you go.");
  const out = await runRequest({ store, callClaude: claude, geocode, request: "json of memory", msgId: "m5", msg: { uid: "u", name: "Igor" }, now });
  assert.deepEqual(out.links, [{ label: "Download memory (JSON)", url: "#export", kind: "export" }]);
  const sys = claude.seen[0].system;
  assert.match(sys, /SU 2026-10-25 16:00/);
  assert.match(sys, /k1: Kids are Masha and Dima\. \(from Igor/);
  assert.match(sys, /Olga \(family chat\): Masha has soccer now/);
  assert.ok(TOOLS.every((t) => t.input_schema.type === "object"));
});

test("matchPlace", () => {
  const places = [{ id: "a", name: "Lakeside Park", aliases: ["the lake"] }];
  assert.equal(matchPlace(places, "lakeside park")?.id, "a");
  assert.equal(matchPlace(places, "The Lake")?.id, "a");
  assert.equal(matchPlace(places, "Lakeside Park, 1 Lake Rd")?.id, "a");
  assert.equal(matchPlace(places, "Lakewood"), null);
});

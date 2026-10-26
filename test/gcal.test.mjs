import test from "node:test";
import assert from "node:assert/strict";
import { googleId, zonedToUtc, recurrenceLines, toGoogleEvent, syncAll, pushOne, oauthClient, calendarApi, isRevoked, GoogleError } from "../functions/gcal.js";
import { runRequest } from "../functions/assistant.js";

const appUrl = "https://family.example";

test("google ids are stable base32hex", () => {
  const id = googleId("AbC9xYz");
  assert.equal(id, googleId("AbC9xYz"));
  assert.match(id, /^[a-v0-9]{5,1024}$/);
  assert.notEqual(googleId("abc"), googleId("ABC"));
});

test("family wall clock to UTC across daylight saving", () => {
  assert.equal(zonedToUtc("2026-07-01", "18:30:00").toISOString(), "2026-07-01T22:30:00.000Z"); // EDT
  assert.equal(zonedToUtc("2026-12-17", "23:59:59").toISOString(), "2026-12-18T04:59:59.000Z"); // EST
  assert.equal(zonedToUtc("2026-11-01", "12:00:00").toISOString(), "2026-11-01T17:00:00.000Z"); // day DST ends
});

test("weekly timed event: RRULE with local-day UNTIL, EXDATE at the event's time", () => {
  const ev = { id: "e1", title: "Ballet", who: ["Maria"], start: "2026-10-27T18:30", end: "2026-10-27T20:00", allDay: false, placeId: "pbs", recurrence: { freq: "weekly", byDay: ["TU", "TH"], until: "2026-12-17" }, exdates: ["2026-11-26"], notes: "Bring slippers" };
  const g = toGoogleEvent(ev, { name: "Princeton Ballet School", address: "301 N Harrison St" }, { appUrl });
  assert.equal(g.id, googleId("e1"));
  assert.equal(g.summary, "Ballet (Maria)");
  assert.equal(g.location, "Princeton Ballet School, 301 N Harrison St");
  assert.deepEqual(g.start, { dateTime: "2026-10-27T18:30:00", timeZone: "America/New_York" });
  assert.deepEqual(g.end, { dateTime: "2026-10-27T20:00:00", timeZone: "America/New_York" });
  assert.deepEqual(g.recurrence, [
    "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=TU,TH;UNTIL=20261218T045959Z",
    "EXDATE;TZID=America/New_York:20261126T183000",
  ]);
  assert.match(g.description, /^Bring slippers\n\nFrom the family calendar: https:\/\/family\.example\/#calendar$/);
  assert.equal(g.extendedProperties.private.familyEventId, "e1");
});

test("all-day multi-day event: exclusive end; monthly every 2 with date UNTIL", () => {
  const trip = toGoogleEvent({ id: "e3", title: "Soccer tournament", start: "2026-10-31", end: "2026-11-01", allDay: true, location: "Mercer fields" }, null, { appUrl });
  assert.deepEqual([trip.start, trip.end], [{ date: "2026-10-31" }, { date: "2026-11-02" }]);
  assert.equal(trip.location, "Mercer fields");
  assert.equal(trip.recurrence, undefined);
  assert.deepEqual(recurrenceLines({ start: "2026-11-05", allDay: true, recurrence: { freq: "monthly", interval: 2, until: "2027-06-30" }, exdates: ["2027-01-05"] }),
    ["RRULE:FREQ=MONTHLY;INTERVAL=2;UNTIL=20270630", "EXDATE;VALUE=DATE:20270105"]);
});

/** In-memory stand-in for calendarApi. */
function fakeApi(existing = []) {
  const items = new Map(existing.map((id) => [id, { id }]));
  const calls = [];
  return {
    items, calls,
    async upsert(cal, gev) { calls.push(["upsert", gev.id]); if (gev.summary === "boom") throw new GoogleError(400, "badRequest", "bad"); items.set(gev.id, gev); },
    async remove(cal, gid) { calls.push(["remove", gid]); items.delete(gid); },
    async listIds() { return [...items.keys()]; },
  };
}

test("full sync upserts every event, removes stale ones, reports failures", async () => {
  const keep = googleId("e1");
  const api = fakeApi([keep, `${keep}_20261027T223000Z`, googleId("gone"), "someoneelse"]);
  const out = await syncAll({
    api, calendarId: "c", appUrl,
    events: [{ id: "e1", title: "Ballet", start: "2026-10-27T18:30" }, { id: "e2", title: "boom", start: "2026-10-28" }],
    places: [],
  });
  assert.deepEqual(out, { pushed: 1, removed: 2, failed: [{ id: "e2", title: "boom", error: "Google 400 badRequest: bad" }] });
  assert.deepEqual([...api.items.keys()].sort(), [keep, `${keep}_20261027T223000Z`].sort());
});

test("pushOne: change upserts, deletion removes", async () => {
  const api = fakeApi();
  await pushOne({ api, calendarId: "c", id: "e9", ev: { title: "Swim", start: "2026-10-26T16:00", end: "2026-10-26T17:00" }, appUrl });
  assert.equal(api.items.get(googleId("e9")).summary, "Swim");
  await pushOne({ api, calendarId: "c", id: "e9", ev: null, appUrl });
  assert.equal(api.items.size, 0);
});

/** fetch stub: routes "METHOD url-substring" to a response. */
function stubFetch(routes) {
  const seen = [];
  const fn = async (url, opts = {}) => {
    const method = opts.method || "GET";
    seen.push({ method, url: String(url), body: opts.body });
    for (const [key, [status, body]] of Object.entries(routes)) {
      const [m, part] = key.split(" ");
      if (m === method && String(url).includes(part)) return new Response(status === 204 ? null : JSON.stringify(body), { status });
    }
    throw new Error("unexpected " + method + " " + url);
  };
  fn.seen = seen;
  return fn;
}

test("oauth: consent URL asks for offline calendar.app.created; exchange reads the email; invalid_grant is a revoke", async () => {
  const idToken = ["x", Buffer.from(JSON.stringify({ email: "igor@example.com" })).toString("base64url"), "y"].join(".");
  const fetch = stubFetch({ "POST oauth2.googleapis.com/token": [200, { access_token: "at", refresh_token: "rt", expires_in: 3599, id_token: idToken, scope: "openid https://www.googleapis.com/auth/calendar.app.created" }] });
  const o = oauthClient({ clientId: "cid", clientSecret: "sec", fetch });
  const u = new URL(o.authUrl({ redirectUri: "https://family.example/gcal/callback", state: "n1", loginHint: "igor@example.com" }));
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.match(u.searchParams.get("scope"), /calendar\.app\.created/);
  assert.equal(u.searchParams.get("state"), "n1");
  const t = await o.exchange("code1", "https://family.example/gcal/callback");
  assert.equal(t.email, "igor@example.com");
  assert.equal(t.refreshToken, "rt");
  assert.match(fetch.seen[0].body.toString(), /grant_type=authorization_code/);

  const bad = oauthClient({ clientId: "cid", clientSecret: "sec", fetch: stubFetch({ "POST /token": [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }] }) });
  await assert.rejects(bad.refresh("rt"), (e) => isRevoked(e));
});

test("calendar api: upsert falls back to insert on 404; deletes ignore missing", async () => {
  const fetch = stubFetch({
    "PUT /events/fam": [404, { error: { message: "Not Found" } }],
    "POST /calendars/cal%40group/events": [200, { id: "fam65" }],
    "DELETE /events/": [410, { error: { message: "Gone" } }],
  });
  const api = calendarApi("at", { fetch });
  assert.deepEqual(await api.upsert("cal@group", { id: "fam65" }), { id: "fam65" });
  await api.remove("cal@group", "fam65");
  assert.deepEqual(fetch.seen.map((s) => s.method), ["PUT", "POST", "DELETE"]);
  assert.equal(fetch.seen[0].url, "https://www.googleapis.com/calendar/v3/calendars/cal%40group/events/fam65");
});

test("private assistant knows whether Google Calendar is connected", async () => {
  const prompts = [];
  const callClaude = async ({ system }) => { prompts.push(system); return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; };
  const store = (gcal) => ({
    list: async () => [], add: async () => "x", update: async () => {}, del: async () => {},
    recentMessages: async () => [], recentThread: async () => [], get: async () => gcal,
  });
  const now = { date: "2026-10-25", time: "16:00", dateTime: "2026-10-25T16:00", weekday: "SU" };
  const base = { callClaude, geocode: async () => null, request: "is my google calendar synced?", msgId: "t1", now };
  await runRequest({ ...base, store: store({ state: "connected", email: "igor@example.com" }), msg: { uid: "u1", name: "Igor", channel: "private" } });
  await runRequest({ ...base, store: store(null), msg: { uid: "u1", name: "Igor", channel: "private" } });
  await runRequest({ ...base, store: store({ state: "connected" }), msg: { uid: "u1", name: "Igor", channel: "assistant" } });
  assert.match(prompts[0], /Google Calendar is connected \(igor@example\.com\)/);
  assert.match(prompts[1], /hasn't connected Google Calendar.*Connect Google Calendar/);
  assert.match(prompts[2], /Assistant tab → Just me → Connect Google Calendar/);
  assert.doesNotMatch(prompts[2], /igor@example/);
});

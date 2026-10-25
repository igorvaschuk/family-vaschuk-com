import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as R from "../public/js/recurrence.js";

test("weekly on Tue/Thu with until and exdates", () => {
  const ev = { id: "a", title: "Soccer", start: "2026-10-27T17:00", end: "2026-10-27T18:30",
    recurrence: { freq: "weekly", byDay: ["TU", "TH"], until: "2026-11-12" }, exdates: ["2026-11-05"] };
  const occ = R.occurrences(ev, "2026-10-01", "2026-12-31").map((o) => o.start);
  assert.deepEqual(occ, ["2026-10-27T17:00", "2026-10-29T17:00", "2026-11-03T17:00", "2026-11-10T17:00", "2026-11-12T17:00"]);
  assert.equal(R.occurrences(ev, "2026-10-29", "2026-10-29")[0].end, "2026-10-29T18:30");
});

test("biweekly counts weeks from the start week", () => {
  const ev = { id: "b", start: "2026-10-26T09:00", recurrence: { freq: "weekly", interval: 2, byDay: ["MO", "WE"] } };
  assert.deepEqual(R.occurrences(ev, "2026-10-26", "2026-11-11").map((o) => o.date),
    ["2026-10-26", "2026-10-28", "2026-11-09", "2026-11-11"]);
});

test("one-off multi-day event shows inside the range", () => {
  const ev = { id: "c", start: "2026-11-07", end: "2026-11-08", allDay: true };
  assert.equal(R.occurrences(ev, "2026-11-08", "2026-11-08").length, 1);
  assert.equal(R.occurrences(ev, "2026-11-09", "2026-11-10").length, 0);
});

test("monthly and daily", () => {
  assert.deepEqual(R.occurrences({ start: "2026-01-31T10:00", recurrence: { freq: "monthly" } }, "2026-01-01", "2026-04-30").map((o) => o.date),
    ["2026-01-31", "2026-03-31"]);
  assert.equal(R.occurrences({ start: "2026-10-01T07:00", recurrence: { freq: "daily", interval: 3 } }, "2026-10-01", "2026-10-10").length, 4);
});

test("helpers", () => {
  assert.equal(R.weekStart("2026-10-25"), "2026-10-19"); // Sunday → Monday before
  assert.equal(R.familyNow(new Date("2026-10-25T20:00:00Z")).dateTime, "2026-10-25T16:00");
  assert.equal(R.familyNow(new Date("2026-12-25T20:00:00Z")).time, "15:00"); // EST
  assert.ok(R.isDateTime("2026-10-27T17:00") && !R.isDateTime("2026-10-27T25:00") && !R.isDate("2026-13-01"));
  assert.equal(R.describeRecurrence({ freq: "weekly", byDay: ["TU", "TH"], until: "2026-12-20" }), "every Tue & Thu until Dec 20");
  assert.match(R.directionsUrl({ name: "Lakeside Park", address: "1 Lake Rd, Princeton, NJ" }), /destination=Lakeside\+Park%2C\+1\+Lake\+Rd/);
});

test("functions copy is identical", () => {
  assert.equal(readFileSync(new URL("../functions/recurrence.js", import.meta.url), "utf8"),
    readFileSync(new URL("../public/js/recurrence.js", import.meta.url), "utf8"));
});

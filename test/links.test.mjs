import test from "node:test";
import assert from "node:assert/strict";
import { describeLink, splitLinks, siteName } from "../public/js/links.js";

test("names a link by its site and what the address says it is", () => {
  assert.equal(describeLink("https://api.ptcwizard.com/parent_conference_join.php?pta_id=221703&district_id=12345"), "ptcwizard.com · Parent conference join");
  assert.equal(describeLink("https://www.example.com/events/SpringRecital2026"), "example.com · Spring recital");
  assert.equal(describeLink("https://school.example.org/calendar/back-to-school-night.html"), "school.example.org · Back to school night");
  assert.equal(describeLink("https://example.com/"), "example.com");
  assert.equal(describeLink("https://example.com/x/9f8a7b6c5d4e3f2a1b0c"), "example.com");
});

test("well-known meeting and document links get their usual names", () => {
  assert.equal(describeLink("https://us02web.zoom.us/j/81234567890?pwd=abc"), "zoom.us · Zoom meeting");
  assert.equal(describeLink("https://meet.google.com/abc-defg-hij"), "meet.google.com · Google Meet");
  assert.equal(describeLink("https://teams.microsoft.com/l/meetup-join/19%3ameeting"), "teams.microsoft.com · Teams meeting");
  assert.equal(describeLink("https://docs.google.com/forms/d/e/1FAIpQLS/viewform"), "docs.google.com · Google Form");
});

test("technical subdomains are dropped, real ones kept", () => {
  assert.equal(siteName("api.ptcwizard.com"), "ptcwizard.com");
  assert.equal(siteName("www.nyc.gov"), "nyc.gov");
  assert.equal(siteName("schools.nyc.gov"), "schools.nyc.gov");
  assert.equal(siteName("api.io"), "api.io");
});

test("finds links inside text, leaving punctuation outside", () => {
  const parts = splitLinks("Join here: https://api.ptcwizard.com/join.php?pta_id=1. Bring report card.");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "Join here: ");
  assert.deepEqual(parts[1], { url: "https://api.ptcwizard.com/join.php?pta_id=1", label: "ptcwizard.com · Join" });
  assert.equal(parts[2], ". Bring report card.");
  assert.deepEqual(splitLinks("22 Main St"), ["22 Main St"]);
  assert.deepEqual(splitLinks("javascript:alert(1)"), ["javascript:alert(1)"]);
});

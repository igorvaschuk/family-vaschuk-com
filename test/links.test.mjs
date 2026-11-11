import test from "node:test";
import assert from "node:assert/strict";
import { splitLinks, linksIn, stripLinks } from "../public/js/links.js";

test("finds links inside text, leaving punctuation outside", () => {
  const parts = splitLinks("Join here: https://api.ptcwizard.com/join.php?pta_id=1. Bring report card.");
  assert.deepEqual(parts, ["Join here: ", { url: "https://api.ptcwizard.com/join.php?pta_id=1" }, ". Bring report card."]);
  assert.deepEqual(splitLinks("https://us02web.zoom.us/j/812?pwd=abc"), [{ url: "https://us02web.zoom.us/j/812?pwd=abc" }]);
  assert.deepEqual(splitLinks("22 Main St"), ["22 Main St"]);
  assert.deepEqual(splitLinks("javascript:alert(1)"), ["javascript:alert(1)"]);
});

test("links come out of the text and become buttons", () => {
  const notes = "Join here: https://api.ptcwizard.com/join.php?pta_id=1. Bring report card.";
  const loc = "https://api.ptcwizard.com/join.php?pta_id=1";
  assert.deepEqual(linksIn(loc, notes), ["https://api.ptcwizard.com/join.php?pta_id=1"]); // same link once
  assert.equal(stripLinks(notes), "Join here. Bring report card.");
  assert.equal(stripLinks(loc), "");
  assert.equal(stripLinks("Zoom: https://us02web.zoom.us/j/812"), "Zoom");
  assert.equal(stripLinks("Room 204 (https://example.com/map), 2nd floor"), "Room 204, 2nd floor");
  assert.equal(stripLinks("Bring goggles and a towel"), "Bring goggles and a towel");
  assert.deepEqual(linksIn(null, "no links"), []);
});

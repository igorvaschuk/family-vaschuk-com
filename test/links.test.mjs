import test from "node:test";
import assert from "node:assert/strict";
import { splitLinks } from "../public/js/links.js";

test("finds links inside text, leaving punctuation outside", () => {
  const parts = splitLinks("Join here: https://api.ptcwizard.com/join.php?pta_id=1. Bring report card.");
  assert.deepEqual(parts, ["Join here: ", { url: "https://api.ptcwizard.com/join.php?pta_id=1" }, ". Bring report card."]);
  assert.deepEqual(splitLinks("https://us02web.zoom.us/j/812?pwd=abc"), [{ url: "https://us02web.zoom.us/j/812?pwd=abc" }]);
  assert.deepEqual(splitLinks("22 Main St"), ["22 Main St"]);
  assert.deepEqual(splitLinks("javascript:alert(1)"), ["javascript:alert(1)"]);
});

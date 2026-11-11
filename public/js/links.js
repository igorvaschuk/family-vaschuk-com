// Web addresses in event text (often a meeting link from an imported Google
// event) show as a "Join" button instead of the whole address.

/** http(s) addresses inside free text. */
export const URL_RE = /https?:\/\/[^\s<>"'()]+/g;

/** Splits text into strings and { url } parts for each address in it. */
export function splitLinks(text) {
  const s = String(text), out = [];
  let at = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, ""); // a sentence's full stop isn't part of the link
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push({ url });
    at = m.index + url.length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

/** Every distinct address in the given texts, in order. */
export function linksIn(...texts) {
  const urls = texts.filter(Boolean).flatMap((t) => splitLinks(t).filter((x) => typeof x !== "string").map((x) => x.url));
  return [...new Set(urls)];
}

/** The text with its addresses taken out (they become Join buttons):
 *  "Join here: <url>. Bring report card." → "Join here. Bring report card." */
export function stripLinks(text) {
  return splitLinks(text).filter((x) => typeof x === "string").join("")
    .replace(/[ \t]*\([ \t]*\)/g, "") // "(<url>)"
    .replace(/[ \t]*[:–-][ \t]*(?=[.,;!?]|\n|$)/g, "") // "Join here: " left before the full stop
    .replace(/[ \t]+([.,;!?])/g, "$1")
    .replace(/([.,;!?])[.,;]+/g, "$1")
    .replace(/^[ \t]*[.,;][ \t]*/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

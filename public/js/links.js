// Web addresses in event text (often a meeting link from an imported Google
// event) show as a short "Join" link instead of the whole address.

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

// Short, readable names for web addresses in event text, so a meeting link
// from an imported Google event shows as "ptcwizard.com · Parent conference
// join" instead of the whole address.

/** http(s) addresses inside free text. */
export const URL_RE = /https?:\/\/[^\s<>"'()]+/g;

// Well-known services: [host test, path test, name].
const KNOWN = [
  [/(^|\.)zoom\.us$/, /^\/(j|my|w)\//, "Zoom meeting"],
  [/^meet\.google\.com$/, /./, "Google Meet"],
  [/^teams\.(microsoft|live)\.com$/, /./, "Teams meeting"],
  [/(^|\.)webex\.com$/, /./, "Webex meeting"],
  [/^docs\.google\.com$/, /^\/forms\//, "Google Form"],
  [/^forms\.gle$/, /./, "Google Form"],
  [/^docs\.google\.com$/, /^\/document\//, "Google Doc"],
  [/^docs\.google\.com$/, /^\/spreadsheets\//, "Google Sheet"],
  [/^drive\.google\.com$/, /./, "Google Drive file"],
  [/(^|\.)signupgenius\.com$/, /./, "SignUpGenius sign-up"],
];

// Technical subdomains that mean nothing to a person ("api.", "us02web.").
const TECH_SUB = /^(www\d*|api|app|apps|m|web|secure|portal|login|my|us\d*web|[a-z]{2}\d+web)$/;
// Path words that carry no meaning.
const NOISE = new Set(["index", "default", "home", "main", "view", "page", "show", "go", "j", "s", "u", "p", "id",
  "php", "html", "htm", "aspx", "asp", "jsp", "cgi", "do", "action", "en", "us", "v1", "v2", "api", "public"]);

/** "api.ptcwizard.com" → "ptcwizard.com"; keeps hosts that are only two labels. */
export function siteName(host) {
  const parts = host.toLowerCase().split(".");
  while (parts.length > 2 && TECH_SUB.test(parts[0])) parts.shift();
  return parts.join(".");
}

/** Readable words from the address path: "/parent_conference_join.php" → "Parent conference join". */
function pathWords(pathname) {
  const segs = pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  for (const seg of segs.reverse()) {
    const words = seg
      .replace(/\.[a-z0-9]{1,5}$/i, "") // file extension
      .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase
      .split(/[\s_\-+.~]+/)
      .map((w) => w.toLowerCase().replace(/^([a-z]{3,})\d+$/, "$1")) // "recital2026" → "recital"
      // ids, codes and hashes: anything with a digit, or long runs without vowels
      .filter((w) => w.length > 1 && !NOISE.has(w) && !/\d/.test(w) && /[aeiouy]/.test(w) && w.length <= 20);
    if (words.length) {
      const text = words.slice(0, 4).join(" ");
      return text[0].toUpperCase() + text.slice(1);
    }
  }
  return "";
}

/** "ptcwizard.com · Parent conference join", "zoom.us · Zoom meeting", or just the site. */
export function describeLink(url) {
  let u;
  try { u = new URL(url); } catch { return "link"; }
  const host = u.hostname.toLowerCase();
  const site = siteName(host);
  const known = KNOWN.find(([h, p]) => h.test(host) && p.test(u.pathname));
  const what = known ? known[2] : pathWords(u.pathname);
  return what ? `${site} · ${what}` : site;
}

/** Splits text into strings and { url, label } parts for each address in it. */
export function splitLinks(text) {
  const s = String(text), out = [];
  let at = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, ""); // a sentence's full stop isn't part of the link
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push({ url, label: describeLink(url) });
    at = m.index + url.length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

// Calendar math shared by the site (public/js) and the assistant function
// (functions/recurrence.js is an exact copy; a test keeps them identical).
//
// Times are family wall-clock strings with no time zone attached:
//   "2026-10-27T17:00" for a timed event, "2026-10-27" for an all-day one.
// Everything is in the family's time zone (FAMILY_TZ), so a 5pm practice
// stays at 5pm across daylight-saving changes.
//
// An event repeats when it has `recurrence`:
//   { freq: "daily" | "weekly" | "monthly", interval?: 1, byDay?: ["TU","TH"], until?: "2026-12-20" }
// and `exdates` lists dates ("YYYY-MM-DD") that are skipped (one-off cancellations).

export const FAMILY_TZ = "America/New_York";
export const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const DAY_MS = 86400000;
const toUtc = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export const dateOf = (s) => (s || "").slice(0, 10);
export const timeOf = (s) => (s && s.length > 10 ? s.slice(11, 16) : "");
export const addDays = (ymd, n) => fromUtc(toUtc(ymd) + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
export const weekday = (ymd) => new Date(toUtc(ymd)).getUTCDay();
/** Monday of the week containing ymd. */
export const weekStart = (ymd) => addDays(ymd, -((weekday(ymd) + 6) % 7));

export const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s;
export const isDateTime = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)
  && isDate(s.slice(0, 10)) && +s.slice(11, 13) < 24 && +s.slice(14, 16) < 60;

/** "Now" in the family's time zone as { date, time, dateTime, weekday }. */
export function familyNow(at = new Date(), tz = FAMILY_TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, dateTime: `${date}T${time}`, weekday: DAYS[weekday(date)] };
}

function repeatsOn(ev, d) {
  const r = ev.recurrence;
  const start = dateOf(ev.start);
  if (d < start) return false;
  if (r.until && d > r.until) return false;
  const interval = Math.max(1, Math.floor(r.interval || 1));
  const gap = daysBetween(start, d);
  if (r.freq === "daily") return gap % interval === 0;
  if (r.freq === "weekly") {
    const byDay = r.byDay?.length ? r.byDay : [DAYS[weekday(start)]];
    if (!byDay.includes(DAYS[weekday(d)])) return false;
    return (daysBetween(weekStart(start), weekStart(d)) / 7) % interval === 0;
  }
  if (r.freq === "monthly") {
    if (d.slice(8) !== start.slice(8)) return false;
    const months = (+d.slice(0, 4) - +start.slice(0, 4)) * 12 + (+d.slice(5, 7) - +start.slice(5, 7));
    return months % interval === 0;
  }
  return false;
}

/**
 * Occurrences of one event that start between `from` and `to` (dates, inclusive),
 * as { id, event, date, start, end, allDay } in date order.
 */
export function occurrences(ev, from, to) {
  const start = dateOf(ev.start);
  if (!isDate(start)) return [];
  const allDay = !!ev.allDay || !timeOf(ev.start);
  const span = ev.end ? Math.max(0, daysBetween(start, dateOf(ev.end))) : 0;
  const make = (d) => ({
    id: ev.id,
    event: ev,
    date: d,
    allDay,
    start: allDay ? d : `${d}T${timeOf(ev.start)}`,
    end: ev.end ? (allDay ? addDays(d, span) : `${addDays(d, span)}T${timeOf(ev.end) || timeOf(ev.start)}`) : "",
  });
  if (!ev.recurrence) {
    // A one-off event still shows on days it spans (a weekend tournament).
    return start <= to && addDays(start, span) >= from ? [make(start)] : [];
  }
  const out = [];
  const skip = new Set(ev.exdates || []);
  let d = from > start ? from : start;
  const last = ev.recurrence.until && ev.recurrence.until < to ? ev.recurrence.until : to;
  for (let guard = 0; d <= last && guard < 800; d = addDays(d, 1), guard++) {
    if (!skip.has(d) && repeatsOn(ev, d)) out.push(make(d));
  }
  return out;
}

/** All occurrences of many events between two dates, sorted by start. */
export function agenda(events, from, to) {
  return events
    .flatMap((ev) => occurrences(ev, from, to))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.event.title || "").localeCompare(b.event.title || "")));
}

/** Human summary of a recurrence rule: "every Tue & Thu until Dec 20". */
export function describeRecurrence(r) {
  if (!r) return "";
  const names = { SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat" };
  const n = Math.max(1, Math.floor(r.interval || 1));
  let s = r.freq === "daily" ? (n > 1 ? `every ${n} days` : "every day")
    : r.freq === "monthly" ? (n > 1 ? `every ${n} months` : "every month")
    : (n > 1 ? `every ${n} weeks` : "every week");
  if (r.freq === "weekly" && r.byDay?.length) {
    s = (n > 1 ? `every ${n} weeks on ` : "every ") + r.byDay.map((d) => names[d] || d).join(" & ");
  }
  if (r.until) {
    const [y, m, d] = r.until.split("-").map(Number);
    s += " until " + new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return s;
}

/** Google Maps directions link for a saved place (opens the app on phones). */
export function directionsUrl(place, mode = "driving") {
  const dest = place.address || (place.lat != null ? `${place.lat},${place.lng}` : place.name);
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("destination", place.address && place.name && !place.address.startsWith(place.name) ? `${place.name}, ${place.address}` : dest);
  if (mode) u.searchParams.set("travelmode", mode);
  return u.toString();
}

/** Google Maps link that just shows the place. */
export function placeUrl(place) {
  const u = new URL("https://www.google.com/maps/search/");
  u.searchParams.set("api", "1");
  u.searchParams.set("query", place.lat != null ? `${place.lat},${place.lng}` : [place.name, place.address].filter(Boolean).join(", "));
  return u.toString();
}

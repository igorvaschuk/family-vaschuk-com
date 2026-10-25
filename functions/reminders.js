// "Time to leave" reminders: for each timed calendar event at a place on the
// map, push to every family device at (driving time from home + 10 min)
// before it starts. index.js runs this every 5 minutes.
import { familyNow, agenda, addDays, daysBetween, timeOf, directionsUrl } from "./recurrence.js";
import { REMINDER_BUFFER_MIN, DEFAULT_DRIVE_MIN } from "./assistant.js";

const minutes = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
const time12 = (t) => {
  const h = +t.slice(0, 2), m = t.slice(3, 5);
  return `${h % 12 || 12}${m === "00" ? "" : ":" + m} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * Reminders that are due now and haven't been sent yet.
 * Each is { key, title, body, url, eventId, date }; `key` identifies one
 * occurrence so it's only ever sent once.
 */
export function dueReminders({ events, places, now = familyNow(), sent = new Set() }) {
  const byId = new Map(places.map((p) => [p.id, p]));
  const nowMin = minutes(now.time);
  const out = [];
  for (const o of agenda(events.filter((e) => e.remind !== false), now.date, addDays(now.date, 1))) {
    if (o.allDay) continue;
    const place = o.event.placeId && byId.get(o.event.placeId);
    if (!place || place.lat == null || place.isHome) continue;
    const drive = place.driveMinutes ?? DEFAULT_DRIVE_MIN;
    const startsIn = daysBetween(now.date, o.date) * 1440 + minutes(timeOf(o.start)) - nowMin;
    // Due from the leave-by time until the event starts (catches up after a missed run).
    if (startsIn <= 0 || startsIn > drive + REMINDER_BUFFER_MIN) continue;
    const key = `${o.id}_${o.date}`;
    if (sent.has(key)) continue;
    const who = o.event.who?.length ? ` (${o.event.who.join(" & ")})` : "";
    out.push({
      key,
      eventId: o.id,
      date: o.date,
      title: `🚗 Time to leave for ${o.event.title}${who}`,
      body: `Starts ${time12(timeOf(o.start))} at ${place.name} · ${place.driveMinutes != null ? `~${drive} min drive` : "drive time unknown"} · tap to navigate`,
      url: directionsUrl(place),
    });
  }
  return out;
}

/** Driving minutes between two {lat,lng} points: OSRM, else a straight-line estimate. */
export async function drivingMinutes(a, b, { fetch = globalThis.fetch } = {}) {
  try {
    const u = `https://router.project-osrm.org/route/v1/driving/${+a.lng},${+a.lat};${+b.lng},${+b.lat}?overview=false`;
    const res = await fetch(u, { headers: { "User-Agent": "family-assistant (family.vaschuk.com)" } });
    if (res.ok) {
      const j = await res.json();
      const sec = j.routes?.[0]?.duration;
      // OSRM has no traffic; pad it a little.
      if (sec != null) return Math.round((sec / 60) * 1.15 + 2);
    }
  } catch {}
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h));
  return Math.round((km * 1.35) / 45 * 60 + 4);
}

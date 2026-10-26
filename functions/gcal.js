// Google Calendar sync: every family calendar event is copied into a
// "Vaschuk Family" calendar the app creates in the Google account of each
// member who connected one. The family calendar is the source of truth; the
// Google copies are rewritten whenever a family event changes.
//
// Nothing here imports Firebase: index.js passes in fetch and the OAuth
// client, so tests run without the network.
//
// Each family event maps to one Google event whose id is derived from the
// family event's id (googleId), so no id map is stored and every push is
// idempotent. Repeats become RRULE/EXDATE lines in the family's time zone.

import { FAMILY_TZ, addDays, dateOf, timeOf, isDate } from "./recurrence.js";

// calendar.app.created: create secondary calendars and manage only the events
// on them. Nothing else in the member's Google Calendar is visible to the app.
export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.app.created"];
export const CALENDAR_NAME = "Vaschuk Family";

const OAUTH = "https://oauth2.googleapis.com";
const API = "https://www.googleapis.com/calendar/v3";

/* ---------------------------------------------------------------- mapping */

/** Google event id for a family event: base32hex ([a-v0-9]) and stable. */
export const googleId = (familyId) => "fam" + Buffer.from(String(familyId)).toString("hex");

/** The UTC instant of a family wall-clock date and time ("HH:MM:SS"). */
export function zonedToUtc(date, time, tz = FAMILY_TZ) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s = 0] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  // How far the zone's wall clock is ahead of UTC at a given instant.
  const offset = (at) => {
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, +x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  };
  let t = wall - offset(wall);
  t = wall - offset(t); // second pass settles instants near a DST change
  return new Date(t);
}

const compact = (ymd) => ymd.replaceAll("-", "");
const utcStamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RRULE (and EXDATE) lines for a repeating family event. */
export function recurrenceLines(ev) {
  const r = ev.recurrence;
  const allDay = !!ev.allDay || !timeOf(ev.start);
  const rule = [`FREQ=${r.freq.toUpperCase()}`];
  const n = Math.floor(r.interval || 1);
  if (n > 1) rule.push(`INTERVAL=${n}`);
  if (r.freq === "weekly") {
    // recurrence.js counts "every N weeks" in Monday-start weeks.
    rule.push("WKST=MO");
    if (r.byDay?.length) rule.push(`BYDAY=${r.byDay.join(",")}`);
  }
  // "until" is the last date it can happen, inclusive, in the family's zone.
  if (r.until) rule.push(`UNTIL=${allDay ? compact(r.until) : utcStamp(zonedToUtc(r.until, "23:59:59"))}`);
  const lines = ["RRULE:" + rule.join(";")];
  const skipped = (ev.exdates || []).filter(isDate).sort();
  if (skipped.length) {
    lines.push(allDay
      ? `EXDATE;VALUE=DATE:${skipped.map(compact).join(",")}`
      : `EXDATE;TZID=${FAMILY_TZ}:${skipped.map((d) => `${compact(d)}T${timeOf(ev.start).replace(":", "")}00`).join(",")}`);
  }
  return lines;
}

/** The Google Calendar event for a family event (and its saved place, if any). */
export function toGoogleEvent(ev, place, { appUrl }) {
  const allDay = !!ev.allDay || !timeOf(ev.start);
  const start = dateOf(ev.start);
  const out = {
    id: googleId(ev.id),
    status: "confirmed",
    summary: ev.who?.length ? `${ev.title} (${ev.who.join(", ")})` : ev.title,
    description: [ev.notes, `From the family calendar: ${appUrl}/#calendar`].filter(Boolean).join("\n\n"),
    extendedProperties: { private: { familyEventId: ev.id } },
    source: { title: CALENDAR_NAME, url: `${appUrl}/#calendar` },
  };
  const where = place ? [place.name, place.address].filter(Boolean).join(", ") : ev.location;
  if (where) out.location = where;
  if (allDay) {
    // Family all-day ends are inclusive; Google's are exclusive.
    const last = ev.end && isDate(dateOf(ev.end)) && dateOf(ev.end) >= start ? dateOf(ev.end) : start;
    out.start = { date: start };
    out.end = { date: addDays(last, 1) };
  } else {
    const end = ev.end && timeOf(ev.end) && ev.end >= ev.start ? ev.end : ev.start;
    out.start = { dateTime: `${ev.start}:00`, timeZone: FAMILY_TZ };
    out.end = { dateTime: `${end}:00`, timeZone: FAMILY_TZ };
  }
  if (ev.recurrence) out.recurrence = recurrenceLines(ev);
  return out;
}

/* ------------------------------------------------------------ Google APIs */

export class GoogleError extends Error {
  constructor(status, code, detail) {
    super(`Google ${status}${code ? " " + code : ""}: ${String(detail).slice(0, 300)}`);
    this.status = status;
    this.code = code;
  }
}
/** The member revoked access (or the token expired for good): they have to reconnect. */
export const isRevoked = (e) => e instanceof GoogleError && (e.code === "invalid_grant" || e.status === 401);

/** OAuth for one Google OAuth client (web application). */
export function oauthClient({ clientId, clientSecret, fetch = globalThis.fetch }) {
  async function token(params) {
    const res = await fetch(`${OAUTH}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(res.status, json.error, json.error_description || JSON.stringify(json));
    return json;
  }
  return {
    authUrl({ redirectUri, state, loginHint }) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPES.join(" "));
      // offline + consent: always get a refresh token, so syncing works while the member is away.
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("include_granted_scopes", "true");
      u.searchParams.set("state", state);
      if (loginHint) u.searchParams.set("login_hint", loginHint);
      return u.toString();
    },
    /** { refreshToken, accessToken, expiresAt, email, scope } for an authorization code. */
    async exchange(code, redirectUri) {
      const t = await token({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
      // The id token comes straight from Google's token endpoint over TLS, so its claims can be read as is.
      const claims = t.id_token ? JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()) : {};
      return { refreshToken: t.refresh_token || null, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000, email: claims.email || null, scope: t.scope || "" };
    },
    async refresh(refreshToken) {
      const t = await token({ refresh_token: refreshToken, grant_type: "refresh_token" });
      return { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
    },
    async revoke(tok) {
      await fetch(`${OAUTH}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tok }) }).catch(() => {});
    },
  };
}

/** Calendar API calls with one access token. */
export function calendarApi(accessToken, { fetch = globalThis.fetch } = {}) {
  async function call(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(res.status, json.error?.status || json.error?.errors?.[0]?.reason, json.error?.message || JSON.stringify(json));
    return json;
  }
  const cal = (id) => `/calendars/${encodeURIComponent(id)}`;
  return {
    createCalendar: () => call("POST", "/calendars", {
      summary: CALENDAR_NAME,
      description: "The Vaschuk family calendar, kept up to date by family.vaschuk.com. Changes made here are overwritten; change events through the family assistant.",
      timeZone: FAMILY_TZ,
    }),
    /** The calendar, or null if it's gone (the member deleted it). */
    async getCalendar(id) {
      try {
        return await call("GET", cal(id));
      } catch (e) {
        if (e.status === 404 || e.status === 410) return null;
        throw e;
      }
    },
    async deleteCalendar(id) {
      try {
        await call("DELETE", cal(id));
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e;
      }
    },
    /** Creates or replaces the event (same id). */
    async upsert(calendarId, gev) {
      try {
        return await call("PUT", `${cal(calendarId)}/events/${gev.id}`, gev);
      } catch (e) {
        if (e.status !== 404) throw e;
        return call("POST", `${cal(calendarId)}/events`, gev);
      }
    },
    async remove(calendarId, gid) {
      try {
        await call("DELETE", `${cal(calendarId)}/events/${gid}`);
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e;
      }
    },
    /** Ids of every (not deleted) event in the calendar. */
    async listIds(calendarId) {
      const ids = [];
      let page = "";
      do {
        const q = new URLSearchParams({ maxResults: "2500", fields: "items(id),nextPageToken" });
        if (page) q.set("pageToken", page);
        const res = await call("GET", `${cal(calendarId)}/events?${q}`);
        ids.push(...(res.items || []).map((x) => x.id));
        page = res.nextPageToken || "";
      } while (page);
      return ids;
    },
  };
}

/* ------------------------------------------------------------------- sync */

/** Brings one Google calendar in line with the family calendar. */
export async function syncAll({ api, calendarId, events, places, appUrl }) {
  const placesById = new Map(places.map((p) => [p.id, p]));
  const keep = new Set();
  let pushed = 0;
  const failed = [];
  for (const ev of events) {
    const gev = toGoogleEvent(ev, ev.placeId && placesById.get(ev.placeId), { appUrl });
    keep.add(gev.id);
    try {
      await api.upsert(calendarId, gev);
      pushed++;
    } catch (e) {
      if (isRevoked(e)) throw e;
      failed.push({ id: ev.id, title: ev.title, error: e.message });
    }
  }
  let removed = 0;
  for (const gid of await api.listIds(calendarId)) {
    // Recurring-event exceptions look like "<id>_<time>"; their series decides.
    if (keep.has(gid.split("_")[0])) continue;
    await api.remove(calendarId, gid);
    removed++;
  }
  return { pushed, removed, failed };
}

/** Pushes one family event (or its deletion, when ev is null) to one Google calendar. */
export async function pushOne({ api, calendarId, id, ev, place, appUrl }) {
  if (!ev) return api.remove(calendarId, googleId(id));
  return api.upsert(calendarId, toGoogleEvent({ ...ev, id }, place, { appUrl }));
}

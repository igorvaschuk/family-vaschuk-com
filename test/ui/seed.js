const at = (s) => ({ toDate: () => new Date(s) });
window.__SEED = {
  places: [
    { id: "home", name: "Home", address: "12 Elm St, Princeton, NJ 08540", lat: 40.3487, lng: -74.6590, isHome: true, createdAt: at("2026-10-25T19:00:00Z") },
    { id: "pbs", name: "Princeton Ballet School", address: "301 N Harrison St, Princeton, NJ 08540", phone: "(609) 921-7758", lat: 40.3640, lng: -74.6480, driveMinutes: 8, createdAt: at("2026-10-25T19:01:00Z") },
    { id: "pool", name: "Community Park Pool", address: "380 Witherspoon St, Princeton, NJ 08540", phone: "(609) 921-9480", lat: 40.3640, lng: -74.6670, driveMinutes: 6, aliases: ["the pool"], createdAt: at("2026-10-25T19:02:00Z") },
    { id: "mercer", name: "Mercer County Park fields", address: "1638 Old Trenton Rd, West Windsor, NJ 08550", lat: 40.2700, lng: -74.6320, driveMinutes: 19, createdAt: at("2026-10-25T19:03:00Z") },
  ],
  events: [
    { id: "e1", title: "Ballet", who: ["Maria"], start: "2026-10-27T18:30", end: "2026-10-27T20:00", allDay: false, placeId: "pbs", recurrence: { freq: "weekly", byDay: ["TU", "TH"] }, exdates: [], remind: true, createdBy: "Igor" },
    { id: "e2", title: "Swim lesson", who: ["Dima"], start: "2026-10-26T16:00", end: "2026-10-26T17:00", allDay: false, placeId: "pool", recurrence: { freq: "weekly", byDay: ["MO", "WE"] }, exdates: [], notes: "Bring goggles and a towel", remind: true },
    { id: "e3", title: "Soccer tournament", who: ["Dima"], start: "2026-10-31", end: "2026-11-01", allDay: true, placeId: "mercer", recurrence: null, exdates: [] },
  ],
  memory: [
    { id: "k1", fact: "The kids are Maria (8) and Dima (10).", subject: "kids", saidBy: "Igor", createdAt: at("2026-10-25T19:00:00Z") },
    { id: "k2", fact: "Olga drives to ballet on Tuesdays, Igor on Thursdays.", subject: "Maria", saidBy: "Olga", createdAt: at("2026-10-25T19:05:00Z") },
  ],
  auditLog: [
    { id: "a1", action: "place.create", after: { name: "Princeton Ballet School" }, by: "Igor", request: "add Maria's ballet academy tue/thu 6:30-8PM", createdAt: at("2026-10-25T20:10:00Z") },
    { id: "a2", action: "event.create", after: { title: "Ballet" }, by: "Igor", request: "add Maria's ballet academy tue/thu 6:30-8PM", createdAt: at("2026-10-25T20:10:01Z") },
  ],
  messages: [
    { id: "m1", text: "Who's picking up Dima from swim Monday?", uid: "u-olga", name: "Olga Vaschuk", photo: "", createdAt: at("2026-10-25T19:30:00Z") },
    { id: "m2", text: "I can do it", uid: "u-igor", name: "Igor Vaschuk", photo: "", createdAt: at("2026-10-25T19:31:00Z") },
    { id: "m3", text: "add Maria's ballet academy tue/thu 6:30-8PM", uid: "u-igor", name: "Igor Vaschuk", photo: "", channel: "assistant", status: "done", createdAt: at("2026-10-25T20:10:00Z") },
    { id: "m4", uid: "assistant", name: "Family Assistant", photo: "", channel: "assistant", kind: "reply", replyTo: "m3", text: "Added Ballet for Maria at Princeton Ballet School (301 N Harrison St), every Tue & Thu 6:30–8 PM, starting this Tuesday. It's about 8 min from home, so everyone gets a “time to leave” push at 6:12 PM. I picked the Princeton Ballet School — say if it's a different academy.", refs: { events: ["e1"], places: ["pbs"] }, links: [], createdAt: at("2026-10-25T20:10:09Z") },
    { id: "m5", uid: "assistant", name: "Family Assistant", photo: "", channel: "family", kind: "notice", text: "Igor updated the calendar: added “Ballet” for Maria (every Tue & Thu, 6:30 PM, from 2026-10-27).", createdAt: at("2026-10-25T20:10:10Z") },
    { id: "m6", text: "/navigate to the pool", uid: "u-olga", name: "Olga Vaschuk", photo: "", channel: "family", status: "done", createdAt: at("2026-10-25T20:12:00Z") },
    { id: "m7", uid: "assistant", name: "Family Assistant", photo: "", channel: "family", kind: "reply", replyTo: "m6", text: "Here's the way to Community Park Pool — about 6 min from home.", refs: { events: [], places: ["pool"] }, links: [{ label: "Navigate to Community Park Pool", url: "https://www.google.com/maps/dir/?api=1&destination=Community+Park+Pool", kind: "directions", placeId: "pool" }], createdAt: at("2026-10-25T20:12:05Z") },
  ],
};

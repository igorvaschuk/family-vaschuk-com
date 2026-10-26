const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { readFileSync } from "node:fs";
const out = process.argv[2];
const fake = readFileSync(new URL("./fake-firebase.js", import.meta.url), "utf8");
const seed = readFileSync(new URL("./seed.js", import.meta.url), "utf8");
// PW_CHANNEL=msedge uses the installed Edge instead of Playwright's Chromium.
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: process.env.DARK ? "dark" : "light" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.route(/gstatic\.com\/firebasejs\//, (r) => r.fulfill({ contentType: "application/javascript", body: fake }));
await page.addInitScript(seed);
await page.clock.setFixedTime(new Date("2026-10-25T20:15:00Z"));
for (const tab of ["family", "assistant", "assistant/me", "calendar", "map", "memory"]) {
  await page.goto("http://localhost:8123/#" + tab);
  await page.waitForTimeout(tab === "map" ? 2500 : 500);
  await page.screenshot({ path: `${out}/${tab.replace("/", "-")}.png` });
}
// A private request goes to my own thread, not the family's messages.
await page.goto("http://localhost:8123/#assistant/me");
await page.waitForTimeout(400);
await page.fill("#text", "Sync my dentist appointments");
await page.click("#send");
await page.waitForTimeout(300);
console.log("private send:", await page.evaluate(() => JSON.stringify({
  thread: window.__store["users/u-igor/thread"].at(-1).channel,
  family: window.__store.messages.some((m) => m.text === "Sync my dentist appointments"),
})));
await page.screenshot({ path: `${out}/assistant-me-sent.png` });
// Google Calendar card: connected, then not connected (Connect opens the consent URL).
console.log("gcal card:", JSON.stringify(await page.textContent("#gcal-card")));
await page.click("#gcal-card button:has-text('Sync now')");
await page.waitForTimeout(200);
await page.addInitScript(() => { window.__SEED["users/u-igor/settings"] = []; }); // not connected from here on
await page.goto("http://localhost:8123/?gcal=connected#assistant/me");
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/gcal-connect.png` });
console.log("after consent return:", await page.evaluate(() => location.search || "(no query)"), "| toast:", JSON.stringify(await page.textContent(".toast").catch(() => null)));
await page.click("#gcal-card button:has-text('Connect Google Calendar')");
await page.waitForTimeout(300);
console.log("connect went to:", await page.evaluate(() => location.hash));
// The Assistant tab reopens on the conversation used last.
await page.goto("http://localhost:8123/#family");
await page.waitForTimeout(300);
await page.click('.tab[data-tab="assistant"]');
await page.waitForTimeout(300);
console.log("assistant tab reopens at:", await page.evaluate(() => location.hash));
await page.goto("http://localhost:8123/#assistant"); // back to the family conversation for the checks below
// Type a slash command in the family chat: composer switches to "Ask".
await page.goto("http://localhost:8123/#family");
await page.waitForTimeout(400);
await page.fill("#text", "/what's on tomorrow?");
await page.screenshot({ path: `${out}/family-slash.png` });
// Mode button carries the draft to the assistant tab without the slash.
await page.click("#mode");
await page.waitForTimeout(300);
console.log("hash after mode:", await page.evaluate(() => location.hash), "| draft:", await page.inputValue("#text"));
await page.click("#send");
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/assistant-sent.png` });
const last = await page.evaluate(() => [...document.querySelectorAll("#assistant-list .msg")].at(-1)?.innerText);
console.log("last assistant-tab message:", JSON.stringify(last));
await page.goto("http://localhost:8123/#map/pbs");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/map-focus.png` });
await page.goto("http://localhost:8123/#calendar");
await page.waitForTimeout(300);
console.log("calendar next-week check:", await page.evaluate(() => document.querySelector(".calbar h3").textContent));
await page.screenshot({ path: `${out}/calendar-full.png`, fullPage: false });
console.log("errors:", JSON.stringify(errors));
await browser.close();

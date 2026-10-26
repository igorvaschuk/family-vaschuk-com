# Google app verification (production, `vaschuk-com`)

Why: reading members' calendars uses `https://www.googleapis.com/auth/calendar.readonly`, a *sensitive* scope. Until Google verifies the app, everyone who taps **Bring in my events** sees "Google hasn't verified this app". The family-dev project stays unverified (testers click through).

## Checklist

1. **Domain ownership**: `vaschuk.com` as a *Domain* property in [Search Console](https://search.google.com/search-console), verified by DNS. The property is already added; open it and press **Start verification** (it signs in to GoDaddy and adds the TXT record), or choose *Any DNS provider* and add the TXT record by hand at GoDaddy. Use the same Google account that owns the Cloud project (vasche@gmail.com).
2. **Public home page** `https://family.vaschuk.com`: says what the app does and links to the privacy policy (done: "About this site").
3. **Privacy policy** `https://family.vaschuk.com/privacy.html`: Google data use, the Limited Use statement, deletion, contact (done).
4. **Branding** (Google Auth Platform → Branding): app name *Vaschuk Family*, support email, home page, privacy link, authorized domain `vaschuk.com` (done). No logo (a logo adds a separate brand review).
5. **Data access**: `openid`, `userinfo.email`, `calendar.app.created` (non-sensitive) and `calendar.readonly` (sensitive) with its justification (done).
6. **Demo video**, unlisted on YouTube (script below).
7. **Submit** in Google Auth Platform → Verification Center, then answer Google's emails (they come to vasche@gmail.com; replies are expected within a few days).

## Demo video script (2–4 minutes, desktop Chrome, English)

Record the browser window (Windows: **Win+Alt+R** with Xbox Game Bar, or Clipchamp). No narration needed; captions or a sentence typed in the chat are fine. Use a test event in your calendar, e.g. "Kid's pick up".

1. **Home page, signed out**: open `https://family.vaschuk.com`, scroll to *About this site*, click **Privacy policy** and scroll through it, go back.
2. **Sign in** with Google.
3. Open **Assistant → 🔒 Just me**. Show the Google Calendar card.
4. Tap **Bring in my events**. On Google's screens:
   - Click into the **address bar** and slowly scroll through the URL so `client_id=…apps.googleusercontent.com` is readable (Google requires this).
   - Show the app name **Vaschuk Family** and the permission "See and download any calendar you can access…". Tick it and click **Continue**. (While unverified: Advanced → Go to family.vaschuk.com first.)
5. Back in the app, tap **🔎 Check my calendar**, then **Ask**. The assistant lists upcoming events from your Google Calendar.
6. Open Google Calendar in another tab for a moment to show those are your events.
7. Answer, e.g. "add 1 for Valerie". Open the **Calendar** tab and show the event there.
8. Back in **Just me**, point at **Disconnect** on the card (you can click it to show it removes access; reconnect afterwards).

Upload to YouTube as **Unlisted**, title e.g. "Vaschuk Family – Google Calendar access demo".

## What to enter in the Verification Center

- **Scope justification** (`calendar.readonly`), already saved under Data access:
  > Private family website. A family member can choose to bring some of their own Google Calendar events into the shared family calendar. The site reads upcoming events only from the calendars they pick, offers them to that member privately, and adds only the ones they approve; approved events are kept up to date. Nothing in their calendars is ever changed. A narrower read scope that covers listing calendars and reading their events does not exist.
- **Demo video**: the unlisted YouTube link.
- **Additional info** (if asked):
  > The app is used by one family (fewer than 10 people), each signing in with their own Google account. Calendar data is read server-side with the member's consent, shown only to that member, and copied into the shared family calendar only for events they approve. Tokens are stored in Firestore with no client access and are deleted on Disconnect. calendar.app.created is used to keep a "Vaschuk Family" calendar in each member's account in sync with the family calendar.

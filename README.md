# family.vaschuk.com

The Vaschuk family site: a private family chat with a family assistant, a shared calendar for the kids' activities, a map of where they happen, and an auditable assistant memory. The page is `public/index.html` + `public/js/app.js` (no build step).

## Family assistant

Tabs: **Family** (chat), **Assistant**, **Calendar**, **Map**, **Memory**.

- In the Family chat, a message starting with `/` goes to the assistant (`/what's on tomorrow?`); everything else is just chat. The ✨ button next to the message box switches to the Assistant tab (and 💬 back), carrying the draft along.
- In the Assistant tab no slash is needed. Every request and reply, from either place, is listed there. Calendar changes made from the Assistant tab are announced in the family chat.
- The assistant keeps the calendar (one event per activity, with weekly/daily/monthly repeats and skipped dates), looks up new places on the web (name, address, phone), puts them on the map, gives Google Maps directions, and remembers facts people tell it.
- **Time to leave**: for each timed event at a mapped place, every device with notifications on gets a push at *driving time from home + 10 min* before it starts; tapping it opens Google Maps directions. Tell the assistant the home address once ("our home is 12 Elm St, Princeton") so drive times can be computed; until then 20 minutes is assumed.
- Places and events have **Navigate**, **Call** (when a phone is saved) and **Share** buttons. Share uses the phone's share sheet (or copies the details) with a Google Maps link anyone can open.
- **Memory** lists every remembered fact (who said it, when) and the log of every change the assistant made. **Download JSON** exports memory, places, calendar and the full change log; asking the assistant for "a JSON of what you remember" gives the same button.

How it works:

- [functions/index.js](functions/index.js) `familyAssistant` fires on new `messages` that are requests, calls Claude (`claude-sonnet-5-5`, override with `ASSISTANT_MODEL` in `functions/.env`) with tools from [functions/assistant.js](functions/assistant.js), and posts the reply. Claude's web search is used to look up places when the API organization allows it (set `ASSISTANT_WEB_SEARCH=off` to disable).
- Geocoding uses OpenStreetMap Nominatim and drive times use the public OSRM router (no keys; no live traffic, so times are padded 15%). The map is Leaflet with OpenStreetMap tiles.
- `familyReminders` runs every 5 minutes ([functions/reminders.js](functions/reminders.js)) and records each sent reminder in `reminders/{event}_{date}` so it goes out once.
- Firestore: `events`, `places`, `memory`, `auditLog` are readable by family members and written only by the functions (see [firestore.rules](firestore.rules)). Times are stored as family wall-clock strings in America/New_York; [public/js/recurrence.js](public/js/recurrence.js) expands repeats on both sides (`functions/recurrence.js` must stay an identical copy — a test checks).
- Later: kids' live locations can go in a separate collection with their own accounts and show as another layer on the map.

### One-time setup

```sh
# Claude API key (from console.anthropic.com) as a Cloud Functions secret
firebase functions:secrets:set ANTHROPIC_API_KEY --project vaschuk-com
# Deploy all three functions (this enables Cloud Scheduler for the reminders if needed)
cd functions && npm install && cd ..
firebase deploy --only functions:family --project vaschuk-com
```

Then merge to `main` so CI deploys the site and the new Firestore rules. Deploy the functions first: until then, requests just show "no answer from the assistant yet".

### Tests

```sh
node --test test/*.test.mjs          # calendar math, assistant tools, reminders (no network)
```

`test/ui/` has a fake Firebase SDK and sample data for screenshotting the UI with Playwright (`node test/ui/shots.mjs <out-dir>` with `python3 -m http.server 8123 --directory public` running).

## Family chat

Sign in with Google, then chat in real time. Messages live in Firestore (`messages` collection, project `vaschuk-com`, location nam5); [firestore.rules](firestore.rules) lets only allowlisted Google accounts read or post.

The allowlist is the Firestore document `config/members` (field `emails`, lowercase). It's kept out of this public repo on purpose. To invite someone:

```sh
bash scripts/add-member.sh someone@gmail.com
```

To remove someone, edit `config/members` in the [Firebase console](https://console.firebase.google.com/project/vaschuk-com/firestore/data/~2Fconfig~2Fmembers).

### Notifications

Members tap **🔔 Notify me** in the chat header to get a push notification on that device for every new message (except their own). On iPhone/iPad (iOS 16.4+) this only works after **Share → Add to Home Screen** and opening Family from the Home Screen; the page shows that hint. Android and desktop browsers work straight from the site.

- Pushes are data-only; [public/firebase-messaging-sw.js](public/firebase-messaging-sw.js) always shows them itself (iOS revokes push permission from sites that don't), and the open chat page clears them when it's on screen.
- Each opted-in device stores its FCM token in Firestore `tokens/{token}`; signing out removes it.
- [functions/index.js](functions/index.js) (`notifyFamily`, us-central1) fires on every new family-chat `messages` doc (Assistant-tab traffic doesn't push), sends to all tokens except the sender's, and deletes tokens FCM reports as dead.
- The web push (VAPID) key in `public/index.html` is public; it was generated under Project settings → Cloud Messaging.
- App icons: `python scripts/make-icons.py` regenerates `public/*.png` from the house logo.

The functions are deployed by hand, not by CI (it would need much broader deploy permissions):

```sh
cd functions && npm install && cd ..
firebase deploy --only functions:family --project vaschuk-com
```

They use the `family` functions codebase, so deploying them never touches functions other sites in `vaschuk-com` may add.

Firebase Auth (Google provider) is enabled for the project, with `family.vaschuk.com` and `family-vaschuk.web.app` as authorized domains. Firestore rules are project-wide, so if another site in `vaschuk-com` ever uses Firestore, its rules have to be merged into this file.

Static site in `public/`, no build step (Firebase JS SDK loaded from gstatic). Deployed to a separate Firebase Hosting site, `family-vaschuk`, in the `vaschuk-com` Firebase project (hosting target `family`).
DNS: CNAME `family` → `family-vaschuk.web.app` at GoDaddy.

## Deploy

```sh
firebase deploy --only hosting,firestore:rules --project vaschuk-com
```

Firebase CLI is installed globally (`npm i -g firebase-tools`) and needs Node 20+ first on PATH. Without it: `npx -p node@22 -p firebase-tools firebase deploy --only hosting,firestore:rules --project vaschuk-com`.

## Local preview

```sh
python3 -m http.server 8000 --directory public
```

## Dev environment: family-dev.vaschuk.com

A separate Firebase project, `family-dev-vaschuk-com`, with its own sign-in allowlist, Firestore data, rules, Cloud Functions and Claude API key, so testers never touch the real family chat, calendar or phones. Pages show a **DEV · branch · commit** badge.

- **Every push to a branch other than `main`** deploys that branch to dev: site, rules and functions ([.github/workflows/firebase-dev.yml](.github/workflows/firebase-dev.yml)). The last push wins. To put a specific branch back on dev: Actions → *Deploy branch to family-dev* → Run workflow → pick the branch.
- Merging to `main` deploys production as before. Production functions are still deployed by hand.
- The same code serves both: [public/js/config.js](public/js/config.js) reads the hosting project's config from `/__/firebase/init.json`. `.firebaserc` maps the `family` hosting target to `family-vaschuk` (prod) and `family-dev-vaschuk-com` (dev).
- Add a tester: `PROJECT=family-dev-vaschuk-com bash scripts/add-member.sh tester@gmail.com`
- Deploy dev by hand: `firebase deploy --only hosting,firestore:rules,functions:family --project dev`

One-time setup (owner, with gcloud, firebase and gh logged in):

```sh
ANTHROPIC_API_KEY=sk-ant-... bash scripts/setup-dev.sh BILLING_ACCOUNT_ID you@gmail.com olga@gmail.com
```

It creates the project, Firestore, the web app, the tester allowlist, the API key secret, and keyless GitHub deploys scoped to the dev project, then lists the console-only steps: enable Google sign-in, add `family-dev.vaschuk.com` as an authorized domain and as a custom hosting domain (DNS at GoDaddy), and optionally generate a web-push key for dev notifications.

## Auto-deploy

Every push to `main` deploys via [.github/workflows/firebase-hosting.yml](.github/workflows/firebase-hosting.yml) (keyless, Workload Identity Federation). One-time GCP setup: `bash scripts/setup-github-deploy.sh`.

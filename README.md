# family.vaschuk.com

The Vaschuk family site: a private family chat in `public/index.html`.

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
- [functions/index.js](functions/index.js) (`notifyFamily`, us-central1) fires on every new `messages` doc, sends to all tokens except the sender's, and deletes tokens FCM reports as dead.
- The web push (VAPID) key in `public/index.html` is public; it was generated under Project settings → Cloud Messaging.
- App icons: `python scripts/make-icons.py` regenerates `public/*.png` from the house logo.

The function is deployed by hand, not by CI (it would need much broader deploy permissions):

```sh
cd functions && npm install && cd ..
firebase deploy --only functions:family --project vaschuk-com
```

It uses the `family` functions codebase, so deploying it never touches functions other sites in `vaschuk-com` may add.

Firebase Auth (Google provider) is enabled for the project, with `family.vaschuk.com` and `family-vaschuk.web.app` as authorized domains. Firestore rules are project-wide, so if another site in `vaschuk-com` ever uses Firestore, its rules have to be merged into this file.

Static site in `public/`, no build step (Firebase JS SDK loaded from gstatic). Deployed to a separate Firebase Hosting site, `family-vaschuk`, in the `vaschuk-com` Firebase project.
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

## Auto-deploy

Every push to `main` deploys via [.github/workflows/firebase-hosting.yml](.github/workflows/firebase-hosting.yml) (keyless, Workload Identity Federation). One-time GCP setup: `bash scripts/setup-github-deploy.sh`.

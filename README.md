# family.vaschuk.com

The Vaschuk family site: a private family chat in `public/index.html`.

## Family chat

Sign in with Google, then chat in real time. Messages live in Firestore (`messages` collection, project `vaschuk-com`, location nam5); [firestore.rules](firestore.rules) lets only allowlisted Google accounts read or post.

The allowlist is the Firestore document `config/members` (field `emails`, lowercase). It's kept out of this public repo on purpose. To invite someone:

```sh
bash scripts/add-member.sh someone@gmail.com
```

To remove someone, edit `config/members` in the [Firebase console](https://console.firebase.google.com/project/vaschuk-com/firestore/data/~2Fconfig~2Fmembers).

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

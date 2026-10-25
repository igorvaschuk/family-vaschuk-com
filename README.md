# family.vaschuk.com

The Vaschuk family site. Currently a "coming soon" page in `public/index.html`.

Static site in `public/`, no build step. Deployed to a separate Firebase Hosting site, `family-vaschuk`, in the `vaschuk-com` Firebase project.
DNS: CNAME `family` → `family-vaschuk.web.app` at GoDaddy.

## Deploy

```sh
firebase deploy --only hosting --project vaschuk-com
```

Firebase CLI is installed globally (`npm i -g firebase-tools`) and needs Node 20+ first on PATH. Without it: `npx -p node@22 -p firebase-tools firebase deploy --only hosting --project vaschuk-com`.

## Local preview

```sh
python3 -m http.server 8000 --directory public
```

## Auto-deploy

Every push to `main` deploys via [.github/workflows/firebase-hosting.yml](.github/workflows/firebase-hosting.yml) (keyless, Workload Identity Federation). One-time GCP setup: `bash scripts/setup-github-deploy.sh`.

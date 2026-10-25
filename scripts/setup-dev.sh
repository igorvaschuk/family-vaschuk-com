#!/usr/bin/env bash
# One-time setup of the dev environment: Firebase project family-dev-vaschuk-com
# serving family-dev.vaschuk.com, plus keyless GitHub deploys of any branch
# (.github/workflows/firebase-dev.yml). Safe to re-run; finished steps are skipped.
#
#   ANTHROPIC_API_KEY=sk-ant-... bash scripts/setup-dev.sh BILLING_ACCOUNT_ID you@gmail.com [more testers...]
#
# BILLING_ACCOUNT_ID: `gcloud billing accounts list` (Cloud Functions need the
# Blaze plan; family-scale use stays inside the free tier). The emails are the
# Google accounts allowed into the dev site. Needs: gcloud (logged in as the
# project owner), firebase CLI, and gh (logged in) to set the repo variables.
# A few steps only exist in the Firebase console; the script lists them at the end.
set -euo pipefail

PROJECT=family-dev-vaschuk-com
REPO=igorvaschuk/family-vaschuk-com
REGION=us-central1
BILLING=${1:?usage: $0 BILLING_ACCOUNT_ID tester@gmail.com [...]}
shift
[ $# -gt 0 ] || { echo "Give at least one tester email." >&2; exit 1; }
SA=family-deployer@${PROJECT}.iam.gserviceaccount.com
step() { printf '\n==> %s\n' "$*"; }

step "Project"
gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null 2>&1 \
  || gcloud projects create "$PROJECT" --name="Vaschuk Family (dev)"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud billing projects link "$PROJECT" --billing-account="$BILLING" --format=none

step "Firebase"
firebase projects:list --json 2>/dev/null | grep -q "\"projectId\": \"$PROJECT\"" || firebase projects:addfirebase "$PROJECT"

step "APIs"
gcloud services enable --project "$PROJECT" \
  firestore.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com \
  identitytoolkit.googleapis.com fcm.googleapis.com \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  run.googleapis.com eventarc.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

step "Firestore (nam5, same as production)"
gcloud firestore databases describe --project "$PROJECT" --format=none 2>/dev/null \
  || gcloud firestore databases create --project "$PROJECT" --location=nam5 --format=none

step "Web app and hosting site (the app config is served at /__/firebase/init.json, read by public/js/config.js)"
firebase apps:list WEB --project "$PROJECT" --json 2>/dev/null | grep -q '"displayName": "family-dev"' \
  || firebase apps:create WEB family-dev --project "$PROJECT"
firebase hosting:sites:get "$PROJECT" --project "$PROJECT" >/dev/null 2>&1 \
  || firebase hosting:sites:create "$PROJECT" --project "$PROJECT"

step "Tester allowlist (config/members)"
PROJECT="$PROJECT" bash "$(dirname "$0")/add-member.sh" "$@"

step "Claude API key secret"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  printf %s "$ANTHROPIC_API_KEY" | firebase functions:secrets:set ANTHROPIC_API_KEY --data-file=- --project "$PROJECT" --force
else
  echo "ANTHROPIC_API_KEY not set; skipping. Later: firebase functions:secrets:set ANTHROPIC_API_KEY --project $PROJECT"
fi

step "GitHub deploys (Workload Identity Federation, dev project only)"
gcloud iam workload-identity-pools describe github --project "$PROJECT" --location=global --format=none 2>/dev/null \
  || gcloud iam workload-identity-pools create github --project "$PROJECT" --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe family-repo --project "$PROJECT" --location=global --workload-identity-pool=github --format=none 2>/dev/null \
  || gcloud iam workload-identity-pools providers create-oidc family-repo \
    --project "$PROJECT" --location=global --workload-identity-pool=github \
    --display-name="family-vaschuk-com repo" \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${REPO}'"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" --format=none 2>/dev/null \
  || gcloud iam service-accounts create family-deployer --project "$PROJECT" --display-name="family-dev GitHub deployer"
# Deploying functions needs broad rights; acceptable because this project holds
# only test data. Production's deployer stays limited to hosting + rules.
for ROLE in roles/editor roles/firebase.admin roles/cloudfunctions.admin roles/run.admin \
            roles/secretmanager.admin roles/iam.serviceAccountUser roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA}" --role="$ROLE" --condition=None --format=none
done
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project "$PROJECT" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}" \
  --format=none

WIF="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/family-repo"
gh variable set DEV_WIF_PROVIDER --repo "$REPO" --body "$WIF"
gh variable set DEV_SERVICE_ACCOUNT --repo "$REPO" --body "$SA"

cat <<EOF

Done with the scriptable part. Finish in the Firebase console
(https://console.firebase.google.com/project/${PROJECT}):

  1. Authentication → Get started → Sign-in method → Google → Enable (support email: yours).
     Then Settings → Authorized domains → Add domain: family-dev.vaschuk.com
  2. Hosting → Add custom domain: family-dev.vaschuk.com, and add the records
     it shows at GoDaddy (DNS for vaschuk.com).
  3. Optional, for push notifications and leave-time reminders on dev:
     Project settings → Cloud Messaging → Web Push certificates → Generate key pair,
     and paste the public key into public/js/config.js (VAPID["${PROJECT}"]).

Then push any branch, or Actions → "Deploy branch to family-dev" → Run workflow.
Until the custom domain is live: https://${PROJECT}.web.app
EOF

#!/usr/bin/env bash
# One-time setup for .github/workflows/firebase-hosting.yml: lets GitHub Actions
# in igorvaschuk/family-vaschuk-com deploy to Firebase Hosting without any keys.
# Reuses the existing "github" Workload Identity pool in vaschuk-com.
set -euo pipefail

PROJECT=vaschuk-com
PROJECT_NUMBER=1059072294008
REPO=igorvaschuk/family-vaschuk-com
SA=family-deployer@${PROJECT}.iam.gserviceaccount.com

gcloud iam workload-identity-pools providers create-oidc family-repo \
  --project "$PROJECT" --location=global --workload-identity-pool=github \
  --display-name="family-vaschuk-com repo" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='${REPO}'"

gcloud iam service-accounts create family-deployer \
  --project "$PROJECT" --display-name="family.vaschuk.com GitHub deployer"

for ROLE in roles/firebasehosting.admin roles/firebaserules.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA}" --role="$ROLE" --condition=None --format=none
done

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project "$PROJECT" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}" \
  --format=none

echo "Done. Pushes to main now deploy via GitHub Actions."

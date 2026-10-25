#!/usr/bin/env bash
# Adds Google account email(s) to the family chat allowlist (Firestore doc
# config/members in vaschuk-com). Uses your gcloud login; needs project owner.
#   bash scripts/add-member.sh someone@gmail.com [another@gmail.com ...]
set -euo pipefail

[ $# -gt 0 ] || { echo "usage: $0 email [email ...]" >&2; exit 1; }

PROJECT=vaschuk-com
DOC="projects/$PROJECT/databases/(default)/documents/config/members"
VALUES=$(for e in "$@"; do printf '{"stringValue":"%s"},' "$(echo "$e" | tr '[:upper:]' '[:lower:]')"; done)

curl -sf -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents:commit" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: $PROJECT" \
  -H "Content-Type: application/json" \
  -d "{\"writes\":[{\"transform\":{\"document\":\"$DOC\",\"fieldTransforms\":[{\"fieldPath\":\"emails\",\"appendMissingElements\":{\"values\":[${VALUES%,}]}}]}}]}" \
  >/dev/null

echo "Members now:"
curl -sf "https://firestore.googleapis.com/v1/$DOC" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: $PROJECT" \
  | grep -o '"stringValue": *"[^"]*"' | sed 's/.*: *"\(.*\)"/  \1/'

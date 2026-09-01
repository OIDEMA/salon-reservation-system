#!/usr/bin/env bash

set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${PROJECT_NUMBER:?PROJECT_NUMBER is required}"
: "${REGION:?REGION is required}"
: "${APP_HOSTING_BACKEND:?APP_HOSTING_BACKEND is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

SOURCE_BUCKET="firebaseapphosting-sources-${PROJECT_NUMBER}-${REGION}"
ARCHIVE_NAME="${APP_HOSTING_BACKEND}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_SHA:0:12}.zip"
BUILD_ID="build-$(date -u +%Y-%m-%d)-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
API_ROOT="https://firebaseapphosting.googleapis.com/v1beta"
BACKEND_PATH="projects/${PROJECT_ID}/locations/${REGION}/backends/${APP_HOSTING_BACKEND}"
ACCESS_TOKEN="$(gcloud auth print-access-token)"
TASK_DIR="$(mktemp -d)"
ARCHIVE_PATH="${TASK_DIR}/${ARCHIVE_NAME}"

cleanup() {
  rm -rf "${TASK_DIR:?}"
}
trap cleanup EXIT

api_request() {
  local method="$1"
  local url="$2"
  local data="${3:-}"

  if [[ -n "$data" ]]; then
    curl --fail-with-body --silent --show-error \
      --request "$method" \
      --header "Authorization: Bearer ${ACCESS_TOKEN}" \
      --header "Content-Type: application/json" \
      --data "$data" \
      "$url"
  else
    curl --fail-with-body --silent --show-error \
      --request "$method" \
      --header "Authorization: Bearer ${ACCESS_TOKEN}" \
      "$url"
  fi
}

poll_operation() {
  local operation_name="$1"
  local label="$2"
  local response

  for _ in $(seq 1 150); do
    response="$(api_request GET "${API_ROOT}/${operation_name}")"
    if [[ "$(jq -r '.done // false' <<<"$response")" == "true" ]]; then
      if jq -e '.error != null' >/dev/null <<<"$response"; then
        echo "${label} failed:" >&2
        jq '.error' <<<"$response" >&2
        return 1
      fi
      echo "${label} completed."
      return 0
    fi
    sleep 10
  done

  echo "Timed out waiting for ${label}." >&2
  return 1
}

echo "Creating source archive for ${GITHUB_SHA}."
git archive --format=zip --output="$ARCHIVE_PATH" HEAD

SOURCE_URI="gs://${SOURCE_BUCKET}/${ARCHIVE_NAME}"
echo "Uploading source archive to ${SOURCE_URI}."
gcloud storage cp "$ARCHIVE_PATH" "$SOURCE_URI" --quiet

BUILD_PAYLOAD="$(jq -cn \
  --arg source_uri "$SOURCE_URI" \
  '{source:{archive:{userStorageUri:$source_uri,rootDirectory:"apps/web"}}}')"
BUILD_OPERATION="$(api_request POST \
  "${API_ROOT}/${BACKEND_PATH}/builds?buildId=${BUILD_ID}" \
  "$BUILD_PAYLOAD")"
BUILD_OPERATION_NAME="$(jq -er '.name' <<<"$BUILD_OPERATION")"

ROLLOUT_PAYLOAD="$(jq -cn \
  --arg build "${BACKEND_PATH}/builds/${BUILD_ID}" \
  '{build:$build}')"

VALIDATED=false
for _ in $(seq 1 10); do
  RESPONSE_FILE="${TASK_DIR}/rollout-validation.json"
  HTTP_STATUS="$(curl --silent --show-error \
    --output "$RESPONSE_FILE" \
    --write-out '%{http_code}' \
    --request POST \
    --header "Authorization: Bearer ${ACCESS_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$ROLLOUT_PAYLOAD" \
    "${API_ROOT}/${BACKEND_PATH}/rollouts?rolloutId=${BUILD_ID}&validateOnly=true")"

  if [[ "$HTTP_STATUS" =~ ^2 ]]; then
    VALIDATED=true
    break
  fi
  if [[ "$HTTP_STATUS" != "400" ]]; then
    echo "Rollout validation failed with HTTP ${HTTP_STATUS}:" >&2
    jq . "$RESPONSE_FILE" >&2
    exit 1
  fi
  sleep 2
done

if [[ "$VALIDATED" != "true" ]]; then
  echo "Rollout validation did not become ready." >&2
  jq . "$RESPONSE_FILE" >&2
  exit 1
fi

ROLLOUT_OPERATION="$(api_request POST \
  "${API_ROOT}/${BACKEND_PATH}/rollouts?rolloutId=${BUILD_ID}" \
  "$ROLLOUT_PAYLOAD")"
ROLLOUT_OPERATION_NAME="$(jq -er '.name' <<<"$ROLLOUT_OPERATION")"

poll_operation "$BUILD_OPERATION_NAME" "App Hosting build"
poll_operation "$ROLLOUT_OPERATION_NAME" "App Hosting rollout"

BUILD="$(api_request GET "${API_ROOT}/${BACKEND_PATH}/builds/${BUILD_ID}")"
ROLLOUT="$(api_request GET "${API_ROOT}/${BACKEND_PATH}/rollouts/${BUILD_ID}")"
BUILD_STATE="$(jq -r '.state' <<<"$BUILD")"
ROLLOUT_STATE="$(jq -r '.state' <<<"$ROLLOUT")"

if [[ "$BUILD_STATE" != "READY" || "$ROLLOUT_STATE" != "SUCCEEDED" ]]; then
  echo "Unexpected App Hosting result: build=${BUILD_STATE}, rollout=${ROLLOUT_STATE}" >&2
  jq '{state, buildLogsUri, errors, error}' <<<"$BUILD" >&2
  jq '{state, error}' <<<"$ROLLOUT" >&2
  exit 1
fi

echo "App Hosting deployment succeeded (${BUILD_ID})."
echo "Build logs: $(jq -r '.buildLogsUri' <<<"$BUILD")"

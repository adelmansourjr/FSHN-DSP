#!/usr/bin/env bash
set -euo pipefail

# Deploys the try-on API to Cloud Run.
# Configurable via environment variables (export BEFORE running):
#   PROJECT_ID            -> target GCP project (required)
#   DEPLOY_ENV            -> deployment environment name (default: staging)
#   REGION                -> Cloud Run region (default: us-central1)
#   SERVICE_NAME          -> Cloud Run service name (default: tryon-api)
#   REPOSITORY            -> Artifact Registry repo (default: tryon-api)
#   IMAGE_NAME            -> Image name (default: tryon-api)
#   ENV_FILE              -> Path to env file for Cloud Run vars (default: ../.env.<DEPLOY_ENV>)
#   CPU                   -> Cloud Run CPU limit (default: 4)
#   MEMORY                -> Cloud Run memory limit (default: 4Gi)
#   CONCURRENCY           -> Cloud Run request concurrency (default: 2)
#   MAX_INSTANCES         -> Cloud Run max instances (default: 1)
#   DEPLOY_TAG            -> tag to attach to the newly deployed revision (default: candidate)
#   PROMOTE_TO_LATEST     -> if "true", move 100% traffic to the latest ready revision after deploy
#   DELETE_EXISTING       -> If "true", delete the old Cloud Run service before deploy
#   ALLOW_UNAUTHENTICATED -> If "true", allow public ingress (default: false)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEPLOY_ENV=${DEPLOY_ENV:-staging}
PROJECT_ID=${PROJECT_ID:-fshn-6a61b}
REGION=${REGION:-us-central1}
SERVICE_NAME=${SERVICE_NAME:-tryon-api}
REPOSITORY=${REPOSITORY:-tryon-api}
IMAGE_NAME=${IMAGE_NAME:-tryon-api}
SERVICE_ACCOUNT=${SERVICE_ACCOUNT:-}
DEFAULT_ENV_FILE="${ROOT_DIR}/.env.${DEPLOY_ENV}"
ENV_FILE=${ENV_FILE:-"${DEFAULT_ENV_FILE}"}
CPU=${CPU:-4}
MEMORY=${MEMORY:-4Gi}
CONCURRENCY=${CONCURRENCY:-2}
MAX_INSTANCES=${MAX_INSTANCES:-1}
DEPLOY_TAG=${DEPLOY_TAG:-candidate}
PROMOTE_TO_LATEST=${PROMOTE_TO_LATEST:-false}
DELETE_EXISTING=${DELETE_EXISTING:-false}
ALLOW_UNAUTHENTICATED=${ALLOW_UNAUTHENTICATED:-false}
RESERVED_ENV_KEYS=(PORT K_SERVICE K_REVISION K_CONFIGURATION)

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is required (export PROJECT_ID=your-project-id)" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${ROOT_DIR}/.env" ]]; then
    ENV_FILE="${ROOT_DIR}/.env"
  else
  echo "Env file not found at ${ENV_FILE}" >&2
  exit 1
  fi
fi

IMAGE_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:latest"

echo "=> Setting gcloud project"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "=> Ensuring Artifact Registry repository (${REPOSITORY}) exists"
gcloud artifacts repositories describe "${REPOSITORY}" \
  --location "${REGION}" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location "${REGION}" \
    --description "Container images for try-on API"

if [[ "${DELETE_EXISTING}" == "true" ]]; then
  echo "=> Deleting existing Cloud Run service (${SERVICE_NAME}) if present"
  gcloud run services delete "${SERVICE_NAME}" \
    --region "${REGION}" \
    --quiet || true
fi

echo "=> Building and pushing container image"
npm --prefix "${ROOT_DIR}" run prepare:recommender
gcloud builds submit "${ROOT_DIR}" \
  --tag "${IMAGE_PATH}"

function env_file_to_args() {
  local args=()
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    if [[ $line =~ ^([^=]+)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local value="${BASH_REMATCH[2]}"
      for reserved in "${RESERVED_ENV_KEYS[@]}"; do
        if [[ $key == "$reserved" ]]; then
          if [[ -t 1 ]]; then
            echo "Skipping reserved env var $key from ${ENV_FILE}" >&2
          fi
          continue 2
        fi
      done
      value="${value//"/\\"}"
      args+=("${key}=${value}")
    fi
  done < "${ENV_FILE}"
  (IFS=','; echo "${args[*]}")
}

ENV_ARGS=$(env_file_to_args)

if [[ -z "${ENV_ARGS}" ]]; then
  echo "No environment variables found in ${ENV_FILE}."
fi

RUN_FLAGS=(
  --region "${REGION}"
  --image "${IMAGE_PATH}"
  --platform managed
  --memory "${MEMORY}"
  --cpu "${CPU}"
  --cpu-boost
  --concurrency "${CONCURRENCY}"
  --timeout 120
  --max-instances "${MAX_INSTANCES}"
  --update-env-vars "${ENV_ARGS}"
)

if [[ -n "${SERVICE_ACCOUNT}" ]]; then
  RUN_FLAGS+=(--service-account "${SERVICE_ACCOUNT}")
fi

if [[ "${ALLOW_UNAUTHENTICATED}" == "true" ]]; then
  RUN_FLAGS+=(--allow-unauthenticated)
else
  RUN_FLAGS+=(--no-allow-unauthenticated)
fi

if [[ -n "${DEPLOY_TAG}" ]]; then
  RUN_FLAGS+=(--tag "${DEPLOY_TAG}")
fi

echo "=> Deploying to Cloud Run (${SERVICE_NAME})"
gcloud run deploy "${SERVICE_NAME}" "${RUN_FLAGS[@]}"

if [[ "${PROMOTE_TO_LATEST}" == "true" ]]; then
  echo "=> Routing 100% traffic to latest ready revision"
  gcloud run services update-traffic "${SERVICE_NAME}" \
    --region "${REGION}" \
    --to-latest
fi

echo "Deployment complete. Use 'gcloud run services describe ${SERVICE_NAME} --region ${REGION}' to view the URL."

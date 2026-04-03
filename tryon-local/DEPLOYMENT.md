# Try-On API Deployment (Cloud Run)

This guide walks through moving the server to a new Google Cloud project (new account) and cleaning up the previous deployment.

## 1. Prerequisites

1. Install the latest [Google Cloud SDK](https://cloud.google.com/sdk) and run:
   ```bash
   gcloud auth login
   gcloud auth application-default login
   ```
2. Select the Google account and target GCP project for the environment you are deploying.
3. Enable the required services once per project:
   ```bash
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com aiplatform.googleapis.com
   ```
4. Create environment-specific files from `tryon-local/.env.example`:
   - `tryon-local/.env.staging`
   - `tryon-local/.env.production`
5. In each env file, set the correct project, Firebase settings, `INGEST_API_KEY`, and keep `ALLOW_GUEST_AI_ROUTES=0` outside local development.

> The sample values in `.env.example` now match the runtime variables the server expects.

## 2. Delete the old Cloud Run service (if needed)

If the old project still has a Cloud Run service you want to remove:

```bash
OLD_PROJECT_ID=old-project-id
REGION=us-central1
SERVICE=tryon-api

gcloud config set project "$OLD_PROJECT_ID"
gcloud run services delete "$SERVICE" --region "$REGION" --quiet
```

You can also delete the associated Artifact Registry repository if you're done with it:

```bash
gcloud artifacts repositories delete tryon-api --location "$REGION" --quiet
```

## 3. Deploy to the new project

The helper script `scripts/deploy-cloud-run.sh` automates build + deploy and pushes all env vars from the environment-specific env file.

> **Dockerfile**: Cloud Build uses the `tryon-local/Dockerfile` in this repo. It installs dependencies via `npm ci` and runs `npm start`, which boots the TypeScript-aware runtime with `tsx serve.mjs`.

Before the first production rollout, upload the Farfetch seed images into Firebase Storage:

```bash
cd tryon-local
npm run upload:farfetch
```

```bash
cd tryon-local
export PROJECT_ID=your-new-project-id
export DEPLOY_ENV=staging                 # or production
export REGION=us-central1               # optional override
export SERVICE_NAME=tryon-api           # optional override
export REPOSITORY=tryon-api             # optional override
export SERVICE_ACCOUNT=tryon-api-runtime@your-project-id.iam.gserviceaccount.com   # optional
export DELETE_EXISTING=true             # optional; removes existing service before deploy
./scripts/deploy-cloud-run.sh
```

> Reserved Cloud Run variables such as `PORT`, `K_SERVICE`, `K_REVISION`, etc. are automatically skipped when the script loads `.env`, so you can keep them locally without conflicting with the managed runtime.

What the script does:

1. Sets the gcloud project.
2. Ensures the Artifact Registry repository exists (creates if missing).
3. Optionally deletes the Cloud Run service in the new project.
4. Builds the container via Cloud Build and pushes it to Artifact Registry.
5. Deploys to Cloud Run with all variables from `.env.<DEPLOY_ENV>`.

> Public ingress is disabled by default. Keep the service private at the platform layer unless you intentionally need anonymous ingress for a controlled edge proxy.

## 4. Retrieve the new endpoint

```bash
gcloud run services describe tryon-api --region "$REGION" --format='value(status.url)'
```

Update `EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT` or `EXPO_PUBLIC_TRYON_API` in your Expo app (or remote config) to point to `${url}/tryon`.

## 5. Verification checklist

- `curl https://<service-url>/health` returns the project, location, and model you set.
- A signed-in `POST https://<service-url>/tryon` request succeeds both synchronously and with `async=true`.
- Mobile app receives the new endpoint via config and can complete try-on jobs even when the app backgrounded (using the job polling endpoint if needed).

## 6. Troubleshooting

| Issue | Fix |
| --- | --- |
| `PERMISSION_DENIED` when calling Vertex | Ensure the Cloud Run service account has the `Vertex AI User` role and access to the model. |
| `UNAUTHENTICATED` from Vertex | Make sure the Cloud Run service account has Cloud IAM Service Account Token Creator role or uses the default compute service account. |
| Requests blocked by CORS | Set `CORS_ORIGINS` in `.env` and redeploy. |
| Old project still billed | Delete the Cloud Run service and Artifact Registry repo in the old project (see section 2). |

Once verified, commit the updated `.env.example`, `DEPLOYMENT.md`, and script so teammates can follow the same steps.

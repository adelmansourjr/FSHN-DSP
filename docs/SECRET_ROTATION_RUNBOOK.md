# Secret Rotation Runbook

Use this runbook after any credential exposure or before the first production launch.

## Scope

- `server/` Stripe secret key and webhook secret
- `tryon-local/` internal ingest API key
- GCP service-account keys referenced by `GOOGLE_APPLICATION_CREDENTIALS` or inline Firebase Admin JSON
- Any Firebase Storage download tokens that were previously embedded in committed app config

## Rotation Order

1. Create replacement credentials first.
2. Update staging env files and deploy staging.
3. Verify staging health, auth, payments, and try-on flows.
4. Update production env files and deploy production.
5. Revoke the old credentials only after production verification succeeds.

## Stripe

1. Create a new restricted secret key in the Stripe dashboard.
2. Create or rotate the webhook signing secret for the production endpoint.
3. Update:
   - `server/.env.production`
   - `server/.env.staging`
4. Redeploy `server/`.
5. Verify:
   - `/create-payment-intent`
   - `/create-checkout-session`
   - `/finalize-payment-intent`
   - `/stripe-webhook`

## Internal Ingest Key

1. Generate a new random ingest key.
2. Update:
   - `tryon-local/.env.staging`
   - `tryon-local/.env.production`
3. Redeploy `tryon-local/`.
4. Verify:
   - `/internal/recommendations/reindex-listing`
   - `/internal/recommendations/backfill`

## Firebase / GCP Admin Credentials

1. Create a new least-privilege service account or key material for each environment.
2. Update the runtime environment to use either:
   - `GOOGLE_APPLICATION_CREDENTIALS`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
3. Redeploy the affected service.
4. Verify Firestore access from:
   - `server/`
   - `tryon-local/`
5. Revoke the old service-account key in GCP IAM.

## Firebase Storage Download Tokens

1. Identify any objects that had public tokenized URLs committed to the repo.
2. Revoke or replace those object tokens in Firebase Storage.
3. Move the app to untokenized base URLs or env-provided templates only.
4. Verify catalog images still resolve in development and production.

## Completion Checklist

- Staging and production use different env files and credentials.
- No real credentials remain in committed files.
- Old keys are revoked after deployment verification.
- CI is green before production rollout.

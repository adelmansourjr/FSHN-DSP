# FSHN

FSHN is an Expo React Native app backed by:

- a local/mobile app in the repo root
- a Stripe + marketplace backend in [`server/`](./server)
- a try-on / recommender / classifier backend in [`tryon-local/`](./tryon-local)
- Firebase rules tests in [`Testing py/fb auto testing py/`](./Testing%20py/fb%20auto%20testing%20py)
- Firebase Functions source in [`functions/`](./functions)

## Public Repo Note

This public export intentionally excludes content/sample/generated image buckets from:

- `src/data/images/`
- `src/data/images farfetch/`
- `testing-rec/results/visuals/`

The branding assets in [`assets/`](./assets) stay in the repo because Expo config and auth branding depend on them.

Most non-image catalog data stays in the public repo. One large recommender sidecar, `src/data/index.classified.embeddingsfarfetch.json`, is also excluded because it exceeds GitHub's normal file-size limit for a standard push.

## What’s in the app

The main product surfaces in this repo include:

- authentication and account creation
- studio flows for prompt-based outfit recommendations
- virtual try-on
- image classification and search
- uploads, listings, closet, orders, feed, likes, and notifications

## Repo Layout

```text
.
├── App.tsx                         Expo entrypoint
├── app.config.ts                   App config + env-driven endpoints
├── src/                            Mobile app source
├── server/                         Stripe/payment backend
├── tryon-local/                    Try-on, recommender, classifier backend
├── functions/                      Firebase Functions source
├── Testing py/fb auto testing py/  Firebase rules test harness
├── docs/                           Ops/runbooks
└── assets/                         App branding + bundled images
```

## Prerequisites

- Node.js 20.x
- npm
- Xcode for iOS work
- Android Studio for Android work
- Java 21 for Firebase emulator tests
- Google Cloud SDK if you want local AI access through ADC or Cloud Run deploys
- Firebase CLI if you want to deploy functions/rules manually

Optional but commonly needed:

- an Expo dev client or simulator/device
- Stripe test keys
- Firebase project credentials
- Vertex AI / Google Vision access for `tryon-local`

## Install

From the repo root:

```bash
npm ci
npm --prefix server ci
npm --prefix tryon-local ci
npm --prefix "Testing py/fb auto testing py" ci
```

If you need to work on or deploy Firebase Functions, install that workspace too:

```bash
npm --prefix functions install
```

## Environment Setup

The repo already ignores the local env files you should use.

Create your local env files:

```bash
cp .env.example .env
cp server/.env.example server/.env
cp tryon-local/.env.example tryon-local/.env
```

### Root app env (`.env`)

The Expo app reads runtime configuration from the root `.env` through [`app.config.ts`](./app.config.ts).

Important fields:

- `APP_ENV=development|staging|production`
- `TRYON_BASE_URL_*`
- `RECOMMENDER_BASE_URL_*`
- `EXPO_PUBLIC_STRIPE_BACKEND_URL_*`
- Firebase web config values
- public Stripe publishable key
- Google OAuth client IDs

For local development on a physical device, use your laptop’s LAN IP, not `localhost`.

Example:

```dotenv
APP_ENV=development
TRYON_BASE_URL_DEVELOPMENT=http://192.168.1.10:8787
RECOMMENDER_BASE_URL_DEVELOPMENT=http://192.168.1.10:8787
EXPO_PUBLIC_STRIPE_BACKEND_URL_DEVELOPMENT=http://192.168.1.10:4242
```

After changing the root `.env`, restart Expo. `app.config.ts` is evaluated at startup.

### Payments backend env (`server/.env`)

Main values:

- `PORT=4242`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `PUBLIC_BASE_URL`
- `FIREBASE_PROJECT_ID`
- either `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`

### Try-on backend env (`tryon-local/.env`)

Main values:

- `PORT=8787`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION`
- `VIRTUAL_TRYON_MODEL`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- recommender model settings
- `INGEST_API_KEY`
- optional Google Search / Vision web-search settings

For local auth to Google services, use one of:

- `gcloud auth application-default login`
- `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json`
- `FIREBASE_SERVICE_ACCOUNT_JSON=...`

Do not reuse any tracked key material in the repo. Use your own environment-specific credentials.

## Running Everything Locally

Start the three local processes in separate terminals.

### 1. Try-on / recommender / classifier API

```bash
npm --prefix tryon-local run start
```

Runs on `http://localhost:8787` by default.

### 2. Stripe / payments backend

```bash
npm --prefix server run dev
```

Runs on `http://localhost:4242` by default.

### 3. Expo app

```bash
npx expo start --clear
```

From there you can:

- press `i` for iOS simulator
- press `a` for Android emulator
- scan the QR code with Expo Go or your dev client

If you want native builds instead of Metro-only startup:

```bash
npm run ios
npm run android
```

## Using the App

Typical local flow:

1. Sign up or sign in.
2. Open Studio to:
   - enter recommendation prompts
   - classify an item image
   - run virtual try-on
3. Use Upload / Listings / Closet / Orders / Feed / Profile as normal.
4. Use the Stripe backend for checkout and order flows.

If try-on or recommendations fail on a physical phone, the first thing to verify is that the root `.env` points to your laptop’s LAN IP and both local backends are running.

## Switching Between Local and Cloud AI Backends

The mobile app can point either to your local `tryon-local` server or to a deployed Cloud Run instance.

### Use local AI backend

Make sure the root `.env` points to your laptop IP on port `8787`, then run:

```bash
npm --prefix tryon-local run start
npx expo start --clear
```

### Use deployed Cloud Run AI backend

Export the cloud base URL before starting Expo:

```bash
export TRYON_BASE_URL="https://your-tryon-service.run.app"
export RECOMMENDER_BASE_URL="https://your-tryon-service.run.app"
npx expo start --clear
```

To switch back:

```bash
unset TRYON_BASE_URL
unset RECOMMENDER_BASE_URL
unset EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT
unset EXPO_PUBLIC_RECOMMENDER_ENDPOINT
unset EXPO_PUBLIC_CLASSIFIER_ENDPOINT
npx expo start --clear
```

This only switches the AI backend. Payments still use `EXPO_PUBLIC_STRIPE_BACKEND_URL`.

## Common Commands

### App

```bash
npm run start
npm run ios
npm run android
npm run web
```

### Payments backend

```bash
npm --prefix server run dev
npm --prefix server run check
npm --prefix server run validate:config
npm --prefix server run test:integration
```

### Try-on backend

```bash
npm --prefix tryon-local run start
npm --prefix tryon-local run check
npm --prefix tryon-local run validate:config
npm --prefix tryon-local run prepare:recommender
npm --prefix tryon-local run upload:farfetch
```

### Firebase rules tests

```bash
npm run check:rules
```

This uses the Firebase emulators through the workspace in [`Testing py/fb auto testing py/`](./Testing%20py/fb%20auto%20testing%20py).

### Root checks

```bash
npm run typecheck
npm run check:server
npm run check:functions
npm run check:tryon
npm run check:config
npm run ci:required
```

## Tests and Verification

Use these depending on what you changed:

- `npm run typecheck`
- `npm --prefix server run test:integration`
- `npm run check:rules`
- `npm run check:server`
- `npm run check:functions`
- `npm run check:tryon`
- `npm run check:config`
- `npm run ci:required`

Notes:

- `server` integration tests are mocked and do not require live Stripe calls.
- Firebase rules tests require Java and the Firebase emulators.
- `check:config` validates the env templates, not your deployed secrets.

## Builds

EAS profiles are defined in [`eas.json`](./eas.json):

- `development`
- `preview`
- `production`

Examples:

```bash
eas build --profile development --platform ios
eas build --profile preview --platform android
eas build --profile production --platform all
```

## Deployment

### Try-on / recommender / classifier backend

Create environment-specific files first:

- `tryon-local/.env.staging`
- `tryon-local/.env.production`

Then deploy from the `tryon-local` workspace:

```bash
cd tryon-local
export PROJECT_ID=your-project-id
npm run deploy:staging
```

or:

```bash
cd tryon-local
export PROJECT_ID=your-project-id
npm run deploy:production
```

Full deployment notes live in [`tryon-local/DEPLOYMENT.md`](./tryon-local/DEPLOYMENT.md).

### Firebase Functions and Rules

If you use Firebase CLI from the repo root:

```bash
firebase deploy --only functions
firebase deploy --only firestore:rules,storage
```

## Production Ops

Useful repo docs:

- [`docs/SECRET_ROTATION_RUNBOOK.md`](./docs/SECRET_ROTATION_RUNBOOK.md)
- [`docs/CLOUD_ALERTING.md`](./docs/CLOUD_ALERTING.md)
- [`tryon-local/DEPLOYMENT.md`](./tryon-local/DEPLOYMENT.md)

## Known Caveats

At the time of writing, the repo still has existing TypeScript debt in parts of `src/components/recommender/`. That means:

- `npm run typecheck` may fail on the current branch
- `npm run ci:required` will inherit the same failure until those typing issues are cleaned up

The service-specific checks are still useful independently:

- `npm run check:server`
- `npm run check:functions`
- `npm run check:tryon`
- `npm run check:config`
- `npm run check:rules`

import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const PROJECT_ID =
  String(
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    'fshn-6a61b',
  ).trim() || 'fshn-6a61b';

const STORAGE_BUCKET =
  String(
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.STORAGE_BUCKET ||
    `${PROJECT_ID}.firebasestorage.app`,
  ).trim() || `${PROJECT_ID}.firebasestorage.app`;

function resolveCredential() {
  const json = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (json) {
    const parsed = JSON.parse(json);
    return {
      credential: cert(parsed),
      projectId: parsed.project_id || PROJECT_ID,
      storageBucket: parsed.storage_bucket || STORAGE_BUCKET,
    };
  }

  return {
    credential: applicationDefault(),
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
  };
}

export function getAdminApp() {
  if (getApps().length) return getApps()[0];
  const config = resolveCredential();
  return initializeApp(config);
}

export function getAdminDb() {
  return getFirestore(getAdminApp());
}

export function getAdminBucket() {
  return getStorage(getAdminApp()).bucket();
}

export function getFirebaseAdminConfig() {
  return {
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
  };
}

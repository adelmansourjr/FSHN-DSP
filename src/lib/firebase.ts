import { initializeApp, getApps } from 'firebase/app';
import type { Analytics } from 'firebase/analytics';
import { getFirestore, initializeFirestore, type Firestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAuth, initializeAuth, type Auth } from 'firebase/auth';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const extra = (Constants?.expoConfig?.extra ?? {}) as Record<string, any>;

const firebaseConfig = {
  apiKey:
    String(extra.EXPO_PUBLIC_FIREBASE_API_KEY || process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '').trim() ||
    'AIzaSyD5AGgvbWfNTzFb_-3w0xnynK1BNMqG_hM',
  authDomain:
    String(
      extra.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ||
        process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ||
        '',
    ).trim() || 'fshn-6a61b.firebaseapp.com',
  projectId:
    String(
      extra.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
        process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
        '',
    ).trim() || 'fshn-6a61b',
  storageBucket:
    String(
      extra.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ||
        process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ||
        '',
    ).trim() || 'fshn-6a61b.firebasestorage.app',
  messagingSenderId:
    String(
      extra.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ||
        process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ||
        '',
    ).trim() || '822496978664',
  appId:
    String(
      extra.EXPO_PUBLIC_FIREBASE_APP_ID || process.env.EXPO_PUBLIC_FIREBASE_APP_ID || '',
    ).trim() || '1:822496978664:web:13c592bf56815aff6e0b5d',
  measurementId:
    String(
      extra.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID ||
        process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID ||
        '',
    ).trim() || 'G-V58LBEHMLC',
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

let analytics: Analytics | null = null;
if (Platform.OS === 'web') {
  try {
    // Avoid importing analytics in native bundles.
    const { getAnalytics } = require('firebase/analytics');
    analytics = getAnalytics(app);
  } catch {
    analytics = null;
  }
}

let auth: Auth;
if (Platform.OS === 'web') {
  auth = getAuth(app);
} else {
  try {
    const firebaseAuthAny = require('firebase/auth') as any;
    auth = initializeAuth(app, {
      persistence: firebaseAuthAny.getReactNativePersistence(AsyncStorage),
    });
  } catch {
    auth = getAuth(app);
  }
}

let db: Firestore;
if (Platform.OS === 'web') {
  db = getFirestore(app);
} else {
  const globalAny = globalThis as any;
  if (globalAny.__FIRESTORE_DB__) {
    db = globalAny.__FIRESTORE_DB__ as Firestore;
  } else {
    try {
      db = initializeFirestore(app, {
        // Force long-polling for RN/Hermes stability.
        experimentalAutoDetectLongPolling: false,
        experimentalForceLongPolling: true,
        // @ts-expect-error RN workaround: disable fetch streams for Hermes stability
        useFetchStreams: false,
        experimentalLongPollingOptions: { timeoutSeconds: 30 },
      });
    } catch {
      db = getFirestore(app);
    }
    globalAny.__FIRESTORE_DB__ = db;
  }
}
const storage = getStorage(app);

export { app, analytics, auth, db, storage };

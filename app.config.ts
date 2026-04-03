import type { ExpoConfig } from '@expo/config-types';

type AppEnv = 'development' | 'staging' | 'production';

const APP_ENV_ALIASES: Record<string, AppEnv> = {
  development: 'development',
  dev: 'development',
  local: 'development',
  preview: 'staging',
  stage: 'staging',
  staging: 'staging',
  production: 'production',
  prod: 'production',
};

function normalizeAppEnv(value?: string | null): AppEnv {
  const raw = String(value || '').trim().toLowerCase();
  return APP_ENV_ALIASES[raw] || 'development';
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function readStageEnv(appEnv: AppEnv, names: string[], fallback = '') {
  const suffix =
    appEnv === 'production'
      ? 'PRODUCTION'
      : appEnv === 'staging'
        ? 'STAGING'
        : 'DEVELOPMENT';

  for (const name of names) {
    const stageValue = process.env[`${name}_${suffix}`];
    if (typeof stageValue === 'string' && stageValue.trim()) {
      return stageValue.trim();
    }
    const genericValue = process.env[name];
    if (typeof genericValue === 'string' && genericValue.trim()) {
      return genericValue.trim();
    }
  }
  return fallback;
}

function deriveEndpoint(explicit: string, baseUrl: string, path: string) {
  if (explicit) return explicit;
  const trimmedBase = stripTrailingSlash(baseUrl);
  if (!trimmedBase) return '';
  return `${trimmedBase}${path}`;
}

export default (): ExpoConfig => {
  const appEnv = normalizeAppEnv(
    process.env.APP_ENV || process.env.EAS_BUILD_PROFILE || process.env.NODE_ENV,
  );

  const tryonBaseUrl = stripTrailingSlash(
    readStageEnv(appEnv, ['TRYON_BASE_URL', 'EXPO_PUBLIC_TRYON_BASE_URL']),
  );
  const recommenderBaseUrl = stripTrailingSlash(
    readStageEnv(appEnv, ['RECOMMENDER_BASE_URL', 'EXPO_PUBLIC_RECOMMENDER_BASE_URL'], tryonBaseUrl),
  );

  const expoConfig: ExpoConfig = {
    name: 'fshn',
    slug: 'fshn',
    scheme: 'fshn',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/app logo light.png',
    userInterfaceStyle: 'light',
    newArchEnabled: true,
    splash: {
      image: './assets/app logo light.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
      dark: {
        image: './assets/app logo dark.png',
        backgroundColor: '#1f1f1f',
      },
    },
    ios: {
      bundleIdentifier: 'com.fshn.app',
      supportsTablet: true,
      infoPlist: {
        NSCameraUsageDescription: 'We use your camera to take an image for virtual try-on.',
        NSPhotoLibraryUsageDescription:
          'We access your photos when you pick an image for try-on.',
        NSPhotoLibraryAddUsageDescription:
          'We save your try-on result to your photo library if you choose.',
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/app logo light.png',
        backgroundColor: '#ffffff',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      permissions: ['android.permission.CAMERA', 'android.permission.READ_MEDIA_IMAGES'],
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-font',
      [
        'expo-image-picker',
        {
          photosPermission: 'We access your photos when you pick an image for try-on.',
          cameraPermission: 'We use your camera to take a selfie for virtual try-on.',
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission: 'We save your try-on result to your photo library if you choose.',
        },
      ],
      'expo-camera',
      'expo-web-browser',
    ],
    extra: {
      APP_ENV: appEnv,
      TRYON_BASE_URL: tryonBaseUrl,
      RECOMMENDER_BASE_URL: recommenderBaseUrl,
      EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT: deriveEndpoint(
        readStageEnv(appEnv, ['EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT']),
        tryonBaseUrl,
        '/tryon',
      ),
      EXPO_PUBLIC_RECOMMENDER_ENDPOINT: deriveEndpoint(
        readStageEnv(appEnv, ['EXPO_PUBLIC_RECOMMENDER_ENDPOINT']),
        recommenderBaseUrl,
        '/recommend',
      ),
      EXPO_PUBLIC_CLASSIFIER_ENDPOINT: deriveEndpoint(
        readStageEnv(appEnv, ['EXPO_PUBLIC_CLASSIFIER_ENDPOINT']),
        recommenderBaseUrl || tryonBaseUrl,
        '/classify',
      ),
      EXPO_PUBLIC_VISION_SEARCH_ENDPOINT: deriveEndpoint(
        readStageEnv(appEnv, ['EXPO_PUBLIC_VISION_SEARCH_ENDPOINT']),
        tryonBaseUrl || recommenderBaseUrl,
        '/vision/search',
      ),
      EXPO_PUBLIC_GCP_PROJECT: readStageEnv(appEnv, ['EXPO_PUBLIC_GCP_PROJECT'], 'fshn-6a61b'),
      EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: readStageEnv(
        appEnv,
        ['EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET'],
        'fshn-6a61b.firebasestorage.app',
      ),
      EXPO_PUBLIC_FARFETCH_CATALOG_BASE_URL: readStageEnv(appEnv, [
        'EXPO_PUBLIC_FARFETCH_CATALOG_BASE_URL',
      ]),
      EXPO_PUBLIC_FARFETCH_IMAGE_URL_TEMPLATE: readStageEnv(appEnv, [
        'EXPO_PUBLIC_FARFETCH_IMAGE_URL_TEMPLATE',
      ]),
      EXPO_PUBLIC_GOOGLE_API_KEY: readStageEnv(appEnv, ['EXPO_PUBLIC_GOOGLE_API_KEY']),
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: readStageEnv(appEnv, [
        'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
      ]),
      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: readStageEnv(appEnv, [
        'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
      ]),
      EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: readStageEnv(appEnv, [
        'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY',
      ]),
      EXPO_PUBLIC_STRIPE_BACKEND_URL: readStageEnv(appEnv, [
        'EXPO_PUBLIC_STRIPE_BACKEND_URL',
      ], appEnv === 'development' ? 'http://localhost:4242' : ''),
      EXPO_PUBLIC_FIREBASE_API_KEY: readStageEnv(
        appEnv,
        ['EXPO_PUBLIC_FIREBASE_API_KEY'],
        'AIzaSyD5AGgvbWfNTzFb_-3w0xnynK1BNMqG_hM',
      ),
      EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: readStageEnv(
        appEnv,
        ['EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN'],
        'fshn-6a61b.firebaseapp.com',
      ),
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: readStageEnv(
        appEnv,
        ['EXPO_PUBLIC_FIREBASE_PROJECT_ID'],
        'fshn-6a61b',
      ),
      EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: readStageEnv(
        appEnv,
        ['EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'],
        '822496978664',
      ),
      EXPO_PUBLIC_FIREBASE_APP_ID: readStageEnv(
        appEnv,
        ['EXPO_PUBLIC_FIREBASE_APP_ID'],
        '1:822496978664:web:13c592bf56815aff6e0b5d',
      ),
      EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: readStageEnv(
        appEnv,
        ['EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID'],
        'G-V58LBEHMLC',
      ),
    },
  };

  return expoConfig;
};

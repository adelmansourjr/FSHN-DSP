const APP_ENV_ALIASES = {
  development: 'development',
  dev: 'development',
  local: 'development',
  preview: 'staging',
  stage: 'staging',
  staging: 'staging',
  production: 'production',
  prod: 'production',
};

function cleanEnvValue(value) {
  return String(value || '').trim();
}

export function normalizeAppEnv(value) {
  const raw = cleanEnvValue(value).toLowerCase();
  return APP_ENV_ALIASES[raw] || 'development';
}

function stageSuffix(appEnv) {
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

export function readStageEnv(name, env = process.env, appEnv = normalizeAppEnv(env.APP_ENV)) {
  const staged = cleanEnvValue(env[`${name}_${stageSuffix(appEnv)}`]);
  if (staged) return staged;
  return cleanEnvValue(env[name]);
}

function parseBoolean(value, fallback = false) {
  const raw = cleanEnvValue(value).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function getTryOnRuntimeConfig(env = process.env) {
  const appEnv = normalizeAppEnv(env.APP_ENV);
  const googleCloudProject = readStageEnv('GOOGLE_CLOUD_PROJECT', env, appEnv);
  const firebaseProjectId =
    readStageEnv('FIREBASE_PROJECT_ID', env, appEnv) || googleCloudProject;

  return {
    appEnv,
    port: readStageEnv('PORT', env, appEnv) || '8787',
    googleCloudProject,
    googleCloudLocation: readStageEnv('GOOGLE_CLOUD_LOCATION', env, appEnv) || 'us-central1',
    virtualTryOnModel:
      readStageEnv('VIRTUAL_TRYON_MODEL', env, appEnv) || 'virtual-try-on-preview-08-04',
    firebaseProjectId,
    firebaseStorageBucket: readStageEnv('FIREBASE_STORAGE_BUCKET', env, appEnv),
    ingestApiKey: readStageEnv('INGEST_API_KEY', env, appEnv),
    allowGuestAiRoutes: parseBoolean(
      readStageEnv('ALLOW_GUEST_AI_ROUTES', env, appEnv),
      appEnv === 'development',
    ),
    corsOrigins: readStageEnv('CORS_ORIGINS', env, appEnv),
  };
}

export function validateTryOnConfig(config = getTryOnRuntimeConfig()) {
  const missing = [];

  if (!config.googleCloudProject) missing.push('GOOGLE_CLOUD_PROJECT');
  if (!config.firebaseProjectId) missing.push('FIREBASE_PROJECT_ID');
  if (!config.firebaseStorageBucket) missing.push('FIREBASE_STORAGE_BUCKET');
  if (config.appEnv !== 'development' && !config.ingestApiKey) missing.push('INGEST_API_KEY');

  if (missing.length) {
    throw new Error(`Missing required try-on config: ${missing.join(', ')}`);
  }

  if (config.appEnv !== 'development' && config.allowGuestAiRoutes) {
    throw new Error('ALLOW_GUEST_AI_ROUTES may only be enabled in development.');
  }

  return config;
}

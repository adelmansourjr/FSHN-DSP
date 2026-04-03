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

const PLACEHOLDER_PATTERNS = [
  /^replace/i,
  /^your-/i,
  /^example/i,
  /^changeme/i,
  /^sk_test_replace_me$/i,
  /^whsec_replace_me$/i,
];

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

function looksLikePlaceholder(value) {
  const clean = cleanEnvValue(value);
  if (!clean) return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(clean));
}

export function getServerRuntimeConfig(env = process.env) {
  const appEnv = normalizeAppEnv(env.APP_ENV);
  return {
    appEnv,
    stripeSecretKey: readStageEnv('STRIPE_SECRET_KEY', env, appEnv),
    stripeWebhookSecret: readStageEnv('STRIPE_WEBHOOK_SECRET', env, appEnv),
    firebaseProjectId: readStageEnv('FIREBASE_PROJECT_ID', env, appEnv),
    firebaseServiceAccountJson: readStageEnv('FIREBASE_SERVICE_ACCOUNT_JSON', env, appEnv),
    publicBaseUrl: readStageEnv('PUBLIC_BASE_URL', env, appEnv),
    port: cleanEnvValue(readStageEnv('PORT', env, appEnv)) || '4242',
    googleApplicationCredentials: cleanEnvValue(env.GOOGLE_APPLICATION_CREDENTIALS),
  };
}

export function validateServerConfig(config = getServerRuntimeConfig(), options = {}) {
  const allowPlaceholders = options.allowPlaceholders === true;
  const missing = [];

  if (!config.stripeSecretKey) missing.push('STRIPE_SECRET_KEY');
  if (!config.firebaseProjectId) missing.push('FIREBASE_PROJECT_ID');

  if (missing.length) {
    throw new Error(`Missing required server config: ${missing.join(', ')}`);
  }

  if (!allowPlaceholders) {
    const placeholderSecrets = [];
    if (looksLikePlaceholder(config.stripeSecretKey)) placeholderSecrets.push('STRIPE_SECRET_KEY');
    if (config.stripeWebhookSecret && looksLikePlaceholder(config.stripeWebhookSecret)) {
      placeholderSecrets.push('STRIPE_WEBHOOK_SECRET');
    }
    if (placeholderSecrets.length) {
      throw new Error(
        `Server config contains placeholder secrets: ${placeholderSecrets.join(', ')}`,
      );
    }
  }

  return config;
}

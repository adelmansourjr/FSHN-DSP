import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { getServerRuntimeConfig, validateServerConfig } from './config.mjs';

const envFile = process.env.ENV_FILE || path.join(process.cwd(), '.env.example');

if (!fs.existsSync(envFile)) {
  throw new Error(`Config file not found: ${envFile}`);
}

const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf8'));
validateServerConfig(getServerRuntimeConfig(parsed), { allowPlaceholders: true });
console.log(`Validated server config template: ${path.relative(process.cwd(), envFile)}`);

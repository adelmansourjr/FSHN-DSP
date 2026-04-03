#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdminBucket, getFirebaseAdminConfig } from '../firebase-admin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PROJECT_ROOT, '..');

const sourceDirArg = process.argv.find((arg) => arg.startsWith('--source='))?.split('=')[1];
const overwrite = process.argv.includes('--overwrite');
const prefix = String(process.env.FARFETCH_STORAGE_PREFIX || 'catalog/farfetch').trim().replace(/^\/+|\/+$/g, '');
const sourceDir = path.resolve(
  sourceDirArg || path.join(REPO_ROOT, 'src/data/images farfetch'),
);

function isImageFile(name) {
  return /\.(?:jpe?g|png|webp|avif)$/i.test(name);
}

function contentTypeFor(fileName) {
  if (/\.png$/i.test(fileName)) return 'image/png';
  if (/\.webp$/i.test(fileName)) return 'image/webp';
  if (/\.avif$/i.test(fileName)) return 'image/avif';
  return 'image/jpeg';
}

async function main() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Farfetch image directory not found: ${sourceDir}`);
  }

  const bucket = getAdminBucket();
  const config = getFirebaseAdminConfig();
  const files = fs.readdirSync(sourceDir).filter(isImageFile).sort();
  let uploaded = 0;
  let skipped = 0;

  for (const fileName of files) {
    const localPath = path.join(sourceDir, fileName);
    const remotePath = `${prefix}/${fileName}`;
    const remoteFile = bucket.file(remotePath);

    if (!overwrite) {
      const [exists] = await remoteFile.exists();
      if (exists) {
        skipped += 1;
        continue;
      }
    }

    await bucket.upload(localPath, {
      destination: remotePath,
      resumable: false,
      metadata: {
        contentType: contentTypeFor(fileName),
        cacheControl: 'public,max-age=3600',
      },
    });
    uploaded += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        bucket: config.storageBucket,
        prefix,
        sourceDir,
        total: files.length,
        uploaded,
        skipped,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

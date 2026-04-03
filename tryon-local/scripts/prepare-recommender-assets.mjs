#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PROJECT_ROOT, '..');

const SOURCE_RECOMMENDER_DIR = path.resolve(REPO_ROOT, 'src/components/recommender');
const SOURCE_CLASSIFIER_DIR = path.resolve(REPO_ROOT, 'src/components/classifier');
const SOURCE_DATA_DIR = path.resolve(REPO_ROOT, 'src/data');

const TARGET_RECOMMENDER_DIR = path.resolve(PROJECT_ROOT, 'reccomender');
const TARGET_CLASSIFIER_DIR = path.resolve(PROJECT_ROOT, 'classifier');
const TARGET_DATA_DIR = path.resolve(PROJECT_ROOT, 'recommender-assets');

const DATA_FILES = [
  { name: 'index.json', required: true },
  { name: 'index.embeddings.json', required: true },
  { name: 'index.classifiedfarfetch.json', required: true },
  { name: 'index.classified.embeddingsfarfetch.json', required: false },
];
const CLASSIFIER_RUNTIME_REWRITE_FILES = [
  path.join('lib', 'text.ts'),
  path.join('lib', 'style_semantics.ts'),
];

function ensureSource(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot find ${label} at ${filePath}`);
  }
}

function resetTarget(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function copyDirectory(src, dest) {
  resetTarget(dest);
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function rewriteCopiedClassifierImports() {
  for (const relativePath of CLASSIFIER_RUNTIME_REWRITE_FILES) {
    const targetPath = path.join(TARGET_CLASSIFIER_DIR, relativePath);
    if (!fs.existsSync(targetPath)) continue;
    const source = fs.readFileSync(targetPath, 'utf8');
    const next = source.replaceAll('../../recommender/', '../../reccomender/');
    if (next !== source) {
      fs.writeFileSync(targetPath, next, 'utf8');
    }
  }
}

try {
  ensureSource(SOURCE_RECOMMENDER_DIR, 'recommender source directory');
  ensureSource(SOURCE_CLASSIFIER_DIR, 'classifier source directory');
  ensureSource(SOURCE_DATA_DIR, 'data directory');

  copyDirectory(SOURCE_RECOMMENDER_DIR, TARGET_RECOMMENDER_DIR);
  copyDirectory(SOURCE_CLASSIFIER_DIR, TARGET_CLASSIFIER_DIR);
  rewriteCopiedClassifierImports();

  for (const file of DATA_FILES) {
    const source = path.join(SOURCE_DATA_DIR, file.name);
    if (!fs.existsSync(source)) {
      if (file.required) {
        throw new Error(`Cannot find data file ${file.name} at ${source}`);
      }
      console.warn(`[prepare-recommender] Skipping optional data file ${file.name}; not found at ${source}`);
      continue;
    }
    copyFile(source, path.join(TARGET_DATA_DIR, file.name));
  }

  console.log('[prepare-recommender] Copied recommender sources to', TARGET_RECOMMENDER_DIR);
  console.log('[prepare-recommender] Copied classifier sources to', TARGET_CLASSIFIER_DIR);
  console.log('[prepare-recommender] Copied data sidecars to', TARGET_DATA_DIR);
} catch (err) {
  console.error('[prepare-recommender] Failed:', err?.message || err);
  process.exit(1);
}

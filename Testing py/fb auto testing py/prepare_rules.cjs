const fs = require('node:fs');
const path = require('node:path');

const SUITE_DIR = __dirname;
const ROOT_DIR = path.resolve(SUITE_DIR, '..', '..');

const copies = [
  ['firestore.rules', 'firestore.rules'],
  ['storage.rules', 'storage.rules'],
];

for (const [sourceName, targetName] of copies) {
  const sourcePath = path.join(ROOT_DIR, sourceName);
  const targetPath = path.join(SUITE_DIR, targetName);
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`synced ${targetName} from ${sourceName}`);
}

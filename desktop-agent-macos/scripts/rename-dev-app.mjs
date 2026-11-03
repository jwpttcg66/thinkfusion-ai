#!/usr/bin/env node
/**
 * Make the development build call itself ThinkFusion.
 *
 * `app.setName()` (see `src/main/index.ts`) renames everything Electron derives
 * from the app name — the menu, the crash reporter, the data folder — but not
 * the Dock: macOS reads that label from the bundle's `CFBundleName` /
 * `CFBundleDisplayName`, and in development the bundle is Electron's own, so the
 * Dock says "Electron" no matter what the code does.
 *
 * So the bundle gets edited. Two facts make that safe here rather than clever:
 *
 * - the Electron.app that npm installs is ad-hoc signed with `Info.plist=not
 *   bound` and `Sealed Resources=none`, so editing the plist does not break the
 *   signature — nothing is sealed that this touches;
 * - it is edited **in place**, at the same path, rather than copied to a second
 *   bundle. macOS grants Accessibility to a path, and this app drives the
 *   browser through one; a renamed copy would be a different app asking for the
 *   same permission again.
 *
 * It is idempotent and cheap, so it runs before `dev` and before `start:debug`.
 * After `npm ci` the bundle is fresh again and the next `dev` renames it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = 'ThinkFusion';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const electronDir = path.join(root, 'node_modules', 'electron');

if (!fs.existsSync(path.join(electronDir, 'path.txt'))) {
  console.log(`skip  ${path.relative(root, electronDir)} is not installed yet`);
  process.exit(0);
}

const executable = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
const bundle = path.join(electronDir, 'dist', executable.split('/Contents/MacOS/')[0]);

// Only ever the development bundle. A packaged build carries its own name from
// `build.productName`, and editing that would be editing a release artefact.
if (!bundle.includes(`${path.sep}node_modules${path.sep}`) || !fs.existsSync(bundle)) {
  console.log(`skip  no development bundle at ${bundle}`);
  process.exit(0);
}

const plist = path.join(bundle, 'Contents', 'Info.plist');
if (!fs.existsSync(plist)) {
  console.log(`skip  ${path.relative(root, plist)} does not exist`);
  process.exit(0);
}

const read = key => {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], {
      encoding: 'utf8'
    }).trim();
  } catch {
    return '';
  }
};

const keys = ['CFBundleName', 'CFBundleDisplayName'];
const stale = keys.filter(key => read(key) !== APP_NAME);
if (stale.length === 0) {
  console.log(`ok    the development bundle already calls itself ${APP_NAME}`);
  process.exit(0);
}

for (const key of stale) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', APP_NAME, plist]);
}

// CFBundleExecutable is left alone on purpose: it names the binary on disk, and
// `node_modules/electron/path.txt` points at it. The Dock reads the two keys
// above, not the executable.
console.log(`ok    ${path.relative(root, bundle)} now presents as ${APP_NAME} (relaunch to see it)`);

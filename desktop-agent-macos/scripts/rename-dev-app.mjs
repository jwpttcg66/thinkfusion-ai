#!/usr/bin/env node
/**
 * Make the development build call itself ThinkFusion.
 *
 * `app.setName()` (see `src/main/index.ts`) renames everything Electron derives
 * from the app name — the menu, the crash reporter, the data folder — but not
 * the Dock. The Dock's label comes from the bundle, and in development the
 * bundle is Electron's own.
 *
 * Editing the two name keys is not enough, and the reason is worth writing down
 * because it cost a round trip: an app started straight from a shell
 * (`electron .`) never goes through LaunchServices, so it has no registration
 * for the Dock to read a display name from (`lsappinfo` reports `bundleID=[NULL]`
 * for exactly this reason) and the Dock falls back to the name of the executable
 * on disk. That name is `Electron`. Changing `CFBundleName` alone therefore
 * changed what `NSRunningApplication.localizedName` answers and nothing that the
 * Dock draws.
 *
 * So the whole identity moves together: the bundle directory, the executable
 * inside it, `CFBundleExecutable`, both name keys, and the bundle identifier —
 * Electron's stock `com.github.Electron` is shared with every other development
 * copy on the machine, which is a poor thing to be. `node_modules/electron/path.txt`
 * is rewritten to match, because that file is how the `electron` CLI finds the
 * binary.
 *
 * Two facts make editing the bundle safe rather than clever:
 *
 * - the Electron.app npm installs is ad-hoc signed with `Info.plist=not bound`
 *   and `Sealed Resources=none` — nothing sealed covers the plist, and renaming
 *   a file does not invalidate a signature that signs its contents;
 * - nothing is copied to a second bundle. There is one bundle at one path, so
 *   there is no second copy of the app to ask for a second permission. (The
 *   Accessibility grant this project relies on belongs to `resources/ax-bridge`,
 *   a separate helper that it spawns, so that grant is not tied to this path at
 *   all — an earlier version of this comment claimed otherwise.)
 *
 * It is idempotent and cheap, so it runs before `dev` and before `start:debug`.
 * After `npm ci` the bundle is fresh again and the next `dev` renames it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = 'ThinkFusion';
const BUNDLE_ID = 'com.thinkfusion.dev';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');

if (!fs.existsSync(pathFile)) {
  console.log(`skip  ${path.relative(root, electronDir)} is not installed yet`);
  process.exit(0);
}

const dist = path.join(electronDir, 'dist');

// Only ever the development bundle. A packaged build carries its own name from
// `build.productName`, and editing that would be editing a release artefact.
if (!dist.includes(`${path.sep}node_modules${path.sep}`) || !fs.existsSync(dist)) {
  console.log(`skip  no development bundle at ${path.relative(root, dist)}`);
  process.exit(0);
}

const stock = path.join(dist, 'Electron.app');
const renamed = path.join(dist, `${APP_NAME}.app`);

if (!fs.existsSync(stock) && !fs.existsSync(renamed)) {
  console.log(`skip  no bundle in ${path.relative(root, dist)}`);
  process.exit(0);
}

const plistOf = bundle => path.join(bundle, 'Contents', 'Info.plist');
const readKey = (plist, key) => {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], {
      encoding: 'utf8'
    }).trim();
  } catch {
    return '';
  }
};
const writeKey = (plist, key, value) => {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
};

// 1. The bundle and the binary inside it, before the plist starts pointing at
//    names that do not exist yet.
if (fs.existsSync(stock)) {
  const oldBinary = path.join(stock, 'Contents', 'MacOS', 'Electron');
  const newBinary = path.join(stock, 'Contents', 'MacOS', APP_NAME);
  if (fs.existsSync(oldBinary) && !fs.existsSync(newBinary)) fs.renameSync(oldBinary, newBinary);
  fs.renameSync(stock, renamed);
}

// 2. What the bundle says about itself.
const plist = plistOf(renamed);
const wanted = {
  CFBundleName: APP_NAME,
  CFBundleDisplayName: APP_NAME,
  CFBundleExecutable: APP_NAME,
  CFBundleIdentifier: BUNDLE_ID
};
const stale = Object.entries(wanted).filter(([key, value]) => readKey(plist, key) !== value);
for (const [key, value] of stale) writeKey(plist, key, value);

// 3. Where the `electron` CLI should look, since it reads this file, not the
//    bundle.
const expected = `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;
const current = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : '';
if (current !== expected) fs.writeFileSync(pathFile, expected);

// 4. Read all of it back. A half-done rename is the exact failure this script
//    exists to prevent, and it stays invisible until someone looks at the Dock —
//    so say it here instead.
const identity = {
  bundle: path.basename(renamed),
  executable: fs.existsSync(path.join(renamed, 'Contents', 'MacOS', APP_NAME)) ? APP_NAME : '',
  CFBundleName: readKey(plist, 'CFBundleName'),
  CFBundleDisplayName: readKey(plist, 'CFBundleDisplayName'),
  CFBundleExecutable: readKey(plist, 'CFBundleExecutable'),
  CFBundleIdentifier: readKey(plist, 'CFBundleIdentifier'),
  pathTxt: fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : ''
};
const agreed = {
  bundle: `${APP_NAME}.app`,
  executable: APP_NAME,
  CFBundleName: APP_NAME,
  CFBundleDisplayName: APP_NAME,
  CFBundleExecutable: APP_NAME,
  CFBundleIdentifier: BUNDLE_ID,
  pathTxt: expected
};
const wrong = Object.keys(agreed).filter(key => identity[key] !== agreed[key]);

if (wrong.length > 0) {
  console.log(`warn  ${path.relative(root, renamed)} does not present as ${APP_NAME} yet:`);
  for (const key of wrong) console.log(`      ${key}: ${identity[key] || '(empty)'}`);
  console.log(`      the Dock will fall back to whatever still disagrees`);
  process.exitCode = 1;
} else if (stale.length === 0 && current === expected) {
  console.log(`ok    the development bundle already calls itself ${APP_NAME}`);
} else {
  const touched = [...(current !== expected ? ['path.txt'] : []), ...stale.map(([key]) => key)];
  console.log(`ok    ${path.relative(root, renamed)} now presents as ${APP_NAME} (${touched.join(', ')})`);
  console.log('      relaunch to see it');
}

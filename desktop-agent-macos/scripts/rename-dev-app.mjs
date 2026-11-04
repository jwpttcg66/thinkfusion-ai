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
 * It is idempotent and cheap, so it runs right after `install:electron`, and
 * that is the only place it needs to be hooked. `install.js` rewrites
 * `path.txt` on every run, even when it skips the download because the version
 * already matches — so anything that calls `install:electron` (dev, build,
 * package) used to leave the file pointing at the factory `Electron.app`, and
 * the next launch came up as Electron: atom icon, "Electron" on hover. That is
 * how the icon and the Dock label went missing a second time. Hooking the
 * rename to the install step instead of to each entry point means a new script
 * cannot forget it.
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

// 0. Both bundles present is not a corner case — it is what `npm run build`
//    leaves behind, because `install:electron` re-extracts Electron.app next to
//    the copy this script renamed. Renaming then fails with ENOTEMPTY, which is
//    how this was found.
//
//    This step used to delete one of the two. It does not any more: deleting a
//    250 MB application bundle to solve a naming problem is the kind of thing
//    that deserves a confirmation prompt, and the script runs unattended from
//    `predev`. Nothing needs the deletion, either —
//
//    - same version: the two bundles are the same build, and `path.txt` decides
//      which one runs. The renamed one wins, the factory copy is inert;
//    - different versions: the older one is *moved* under `dist/.stale/`, not
//      removed, so a bad install can be recovered by hand.
let skipRename = false;
const compareVersions = (a, b) =>
  String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });

if (fs.existsSync(stock) && fs.existsSync(renamed)) {
  const stockVersion = readKey(plistOf(stock), 'CFBundleShortVersionString');
  const renamedVersion = readKey(plistOf(renamed), 'CFBundleShortVersionString');
  if (compareVersions(stockVersion, renamedVersion) === 0) {
    skipRename = true;
    console.log(
      `ok    two bundles of ${stockVersion} found, using ${path.basename(renamed)} (factory copy left in place)`
    );
  } else {
    const stale = compareVersions(stockVersion, renamedVersion) > 0 ? renamed : stock;
    const staleVersion = stale === renamed ? renamedVersion : stockVersion;
    const staleDir = path.join(dist, '.stale');
    fs.mkdirSync(staleDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(staleDir, `${path.basename(stale, '.app')}-${staleVersion}-${stamp}.app`);
    fs.renameSync(stale, target);
    console.log(
      `ok    moved the older bundle (${staleVersion}) to ${path.relative(root, target)} — delete it when you like`
    );
  }
}

// 1. The bundle and the binary inside it, before the plist starts pointing at
//    names that do not exist yet.
if (!skipRename && fs.existsSync(stock)) {
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

// 3. The icon. A packaged build takes it from `build.mac.icon`, but the
//    development bundle is Electron's, and it ships with Electron's atom. The
//    file lands inside the bundle rather than being set at runtime with
//    `app.dock.setIcon()`: the Dock caches by bundle path, so a runtime icon
//    flickers back to the atom on the next launch, and a pinned Dock tile keeps
//    the bundle's icon regardless.
const iconSource = path.join(root, 'resources', 'icon.icns');
const iconTarget = path.join(renamed, 'Contents', 'Resources', 'icon.icns');
let iconChanged = false;
if (fs.existsSync(iconSource)) {
  const same = fs.existsSync(iconTarget) && fs.readFileSync(iconTarget).equals(fs.readFileSync(iconSource));
  if (!same) {
    fs.copyFileSync(iconSource, iconTarget);
    iconChanged = true;
  }
  if (readKey(plist, 'CFBundleIconFile') !== 'icon.icns') {
    writeKey(plist, 'CFBundleIconFile', 'icon.icns');
    iconChanged = true;
  }
  // Touching the bundle is what makes the Dock drop a cached icon; without it
  // the change only shows up after a relaunch of the Dock itself.
  if (iconChanged) {
    const now = new Date();
    fs.utimesSync(renamed, now, now);
  }
}

// 4. Where the `electron` CLI should look, since it reads this file, not the
//    bundle.
const expected = `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;
const current = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : '';
if (current !== expected) fs.writeFileSync(pathFile, expected);

// 5. Read all of it back. A half-done rename is the exact failure this script
//    exists to prevent, and it stays invisible until someone looks at the Dock —
//    so say it here instead.
const identity = {
  bundle: path.basename(renamed),
  executable: fs.existsSync(path.join(renamed, 'Contents', 'MacOS', APP_NAME)) ? APP_NAME : '',
  CFBundleName: readKey(plist, 'CFBundleName'),
  CFBundleDisplayName: readKey(plist, 'CFBundleDisplayName'),
  CFBundleExecutable: readKey(plist, 'CFBundleExecutable'),
  CFBundleIdentifier: readKey(plist, 'CFBundleIdentifier'),
  CFBundleIconFile: readKey(plist, 'CFBundleIconFile'),
  pathTxt: fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : ''
};
const agreed = {
  bundle: `${APP_NAME}.app`,
  executable: APP_NAME,
  CFBundleName: APP_NAME,
  CFBundleDisplayName: APP_NAME,
  CFBundleExecutable: APP_NAME,
  CFBundleIdentifier: BUNDLE_ID,
  CFBundleIconFile: fs.existsSync(iconTarget) ? 'icon.icns' : identity.CFBundleIconFile,
  pathTxt: expected
};
const wrong = Object.keys(agreed).filter(key => identity[key] !== agreed[key]);

if (wrong.length > 0) {
  console.log(`warn  ${path.relative(root, renamed)} does not present as ${APP_NAME} yet:`);
  for (const key of wrong) console.log(`      ${key}: ${identity[key] || '(empty)'}`);
  console.log(`      the Dock will fall back to whatever still disagrees`);
  process.exitCode = 1;
} else if (stale.length === 0 && current === expected && !iconChanged) {
  console.log(`ok    the development bundle already calls itself ${APP_NAME}`);
} else {
  const touched = [
    ...(current !== expected ? ['path.txt'] : []),
    ...stale.map(([key]) => key),
    ...(iconChanged ? ['icon.icns'] : [])
  ];
  console.log(`ok    ${path.relative(root, renamed)} now presents as ${APP_NAME} (${touched.join(', ')})`);
  console.log('      relaunch to see it');
}

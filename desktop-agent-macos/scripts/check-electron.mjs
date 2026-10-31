import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electronPackage = require.resolve('electron/package.json');
const root = path.dirname(electronPackage);
const dist = path.join(root, 'dist');
if (!fs.existsSync(dist)) {
  console.error('Electron binary is not installed. Run: npm run install:electron');
  process.exit(1);
}
const app = path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
if (process.platform === 'darwin' && !fs.existsSync(app)) {
  console.error(`Electron.app binary missing at: ${app}`);
  process.exit(1);
}
console.log(`Electron binary present: ${app}`);

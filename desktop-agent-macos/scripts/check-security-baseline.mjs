/**
 * C-04：发布前安全基线检查（不涉及签名）。
 * 1) 源码不含密钥/私钥/硬编码密码；
 * 2) 依赖不含默认遥测 SDK。
 * 任一项失败即退出 1。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const patterns = [
  { name: 'OpenAI-style key', re: /sk-[A-Za-z0-9]{16,}/ },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: 'hardcoded password', re: /password\s*[:=]\s*['"][^'"]{4,}['"]/i }
];
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        if (pattern.re.test(text)) findings.push(`${path.relative(root, file)}: ${pattern.name}`);
      }
    }
  }
}
walk(src);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const telemetry = ['posthog', '@sentry/node', '@sentry/electron', 'segment', 'mixpanel'];
for (const name of telemetry) {
  if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) findings.push(`package.json: telemetry ${name}`);
}

if (findings.length > 0) {
  console.error(`security baseline failed (${String(findings.length)}):`);
  for (const item of findings) console.error(`- ${item}`);
  process.exit(1);
}
console.log('security baseline OK: no secrets, no default telemetry SDK');

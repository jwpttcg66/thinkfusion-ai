#!/usr/bin/env node
/**
 * Gate 0 spike：构建信任边界。
 *
 * 验证两件事：
 *   1. 只做静态扫描时，不执行 Gradle 构建脚本；
 *   2. 用户显式“批准”后，才执行一个会写标记文件的自定义 task。
 *
 * 这是临时夹具，不是产品代码。Maven 插件样本后续补；这里先用 Gradle
 * 证明“默认不执行、批准才执行”的边界。
 *
 * 运行：
 *   npm run spike:build-trust
 *   npm run spike:build-trust -- --approve
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const approve = process.argv.includes('--approve');
const keep = process.argv.includes('--keep');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-build-trust-'));
const marker = path.join(temp, 'EXECUTED');

fs.writeFileSync(
  path.join(temp, 'settings.gradle'),
  "rootProject.name = 'build-trust-spike'\n"
);
fs.writeFileSync(
  path.join(temp, 'build.gradle'),
  [
    "tasks.register('danger') {",
    "    doLast {",
    "        file('EXECUTED').text = 'yes'",
    "    }",
    "}",
    ''
  ].join('\n')
);

function staticScan() {
  const files = fs.readdirSync(temp);
  return {
    root: temp,
    buildSystem: files.includes('build.gradle') || files.includes('build.gradle.kts') ? 'gradle' : 'unknown',
    files,
    executed: fs.existsSync(marker)
  };
}

function runApprovedBuild() {
  const result = spawnSync('gradle', ['-q', '--offline', '--no-daemon', 'danger'], {
    cwd: temp,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GRADLE_OPTS: '-Dorg.gradle.daemon=false' }
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? '').trim().slice(0, 2000),
    stderr: (result.stderr ?? '').trim().slice(0, 2000),
    executed: fs.existsSync(marker)
  };
}

const scan = staticScan();
const failures = [];

if (scan.executed) failures.push('静态扫描阶段就执行了构建脚本');
if (scan.buildSystem !== 'gradle') failures.push('没有识别出 Gradle 工程');

let approved = null;
if (approve) {
  approved = runApprovedBuild();
  if (!approved.executed) failures.push('批准后没有执行自定义 task');
} else if (fs.existsSync(marker)) {
  failures.push('未批准时出现了执行标记');
}

const report = { approved, scan, failures };
console.log(JSON.stringify(report, null, 2));
if (!keep) fs.rmSync(temp, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`Build trust spike: FAIL（${failures.join('；')}）`);
  process.exitCode = 1;
} else {
  console.log(
    approve
      ? 'Build trust spike: PASS（静态扫描不执行；批准后执行）'
      : 'Build trust spike: PASS（静态扫描不执行）'
  );
}

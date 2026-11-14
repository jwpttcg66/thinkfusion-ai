/**
 * 把 24 题拆成 N 组，同时跑 N 个独立 Electron 回归进程，然后合并结果。
 *
 * 用法：
 *   node scripts/regression/run-debate-regression-parallel.cjs --groups=3
 *   node scripts/regression/run-debate-regression-parallel.cjs --groups=3 --suffix=current-pool-parallel
 *
 * 每个子进程仍然是一题一题串行；并发发生在组之间。
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildSummary, markdown } = require('./summary.cjs');

const HERE = __dirname;
const REPO = path.resolve(HERE, '../../..');
const APP = path.resolve(REPO, 'desktop-agent-macos');
const RUNNER = path.join(HERE, 'run-debate-regression.cjs');
const ELECTRON = path.join(APP, 'node_modules', '.bin', 'electron');
const DATASET = path.join(HERE, 'debate-dataset.json');
const OUT_DIR = path.join(REPO, 'docs', 'implementation', 'regression');

function arg(name, fallback) {
  const found = process.argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const groups = Math.max(1, Math.min(6, Number.parseInt(arg('groups', '3'), 10) || 3));
const suffix = arg('suffix', 'parallel-full').replace(/[^a-zA-Z0-9_-]/g, '');
const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));

const buckets = Array.from({ length: groups }, () => []);
dataset.questions.forEach((question, index) => {
  buckets[index % groups].push(question);
});

function runGroup(bucket, groupIndex) {
  if (bucket.length === 0) return Promise.resolve({ groupIndex, code: 0, output: '' });
  const groupSuffix = `${suffix}-g${groupIndex + 1}`;
  const ids = bucket.map(item => item.id).join(',');
  return new Promise(resolve => {
    const child = spawn(ELECTRON, [RUNNER, '--no-sandbox', `--only=${ids}`, `--suffix=${groupSuffix}`], {
      cwd: APP,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(`[g${groupIndex + 1}] ${text}`);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      process.stderr.write(`[g${groupIndex + 1}!] ${text}`);
    });
    child.on('close', code => resolve({ groupIndex, code, output }));
    child.on('error', error => resolve({ groupIndex, code: 1, output: `${output}\n${String(error)}` }));
  });
}

function resultFile(groupIndex) {
  return path.join(OUT_DIR, `debate-regression-${suffix}-g${groupIndex + 1}-latest.json`);
}

(async () => {
  console.log(`数据集 ${dataset.version} · ${dataset.questions.length} 题 · ${groups} 路并行 · 后缀 ${suffix}`);
  const outcomes = await Promise.all(buckets.map((bucket, index) => runGroup(bucket, index)));
  const byId = new Map();
  let models = [];
  let judgeRotation = [];
  for (const outcome of outcomes) {
    if (outcome.code !== 0) {
      console.error(`组 ${outcome.groupIndex + 1} 退出码 ${outcome.code}`);
    }
    const file = resultFile(outcome.groupIndex);
    if (!fs.existsSync(file)) {
      console.error(`组 ${outcome.groupIndex + 1} 没有结果文件：${file}`);
      continue;
    }
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(payload.models) && payload.models.length > 0) models = payload.models;
    if (Array.isArray(payload.judgeRotation) && payload.judgeRotation.length > 0) judgeRotation = payload.judgeRotation;
    for (const result of payload.results ?? []) byId.set(result.id, result);
  }

  const results = dataset.questions.map(item => byId.get(item.id)).filter(Boolean);
  const summary = buildSummary(results);
  const createdAt = new Date().toISOString();
  const payload = {
    dataset: { version: dataset.version, sha256: dataset.sha256, note: dataset.note },
    models,
    judgeRotation,
    createdAt,
    groups,
    summary,
    results
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const latestJson = path.join(OUT_DIR, `debate-regression-${suffix}-latest.json`);
  fs.writeFileSync(latestJson, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, `debate-regression-${suffix}-latest.md`), markdown(summary, dataset, results), 'utf8');
  const stamp = createdAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(OUT_DIR, `debate-regression-${suffix}-${stamp}.json`), JSON.stringify(payload, null, 2), 'utf8');
  console.log(`MERGED ${latestJson} · ${results.length}/${dataset.questions.length}`);
  console.log(`DONE ${JSON.stringify(summary)}`);
  const allChildrenOk = outcomes.every(item => item.code === 0);
  process.exit(allChildrenOk && summary.structuralOk ? 0 : 2);
})().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

/**
 * Merge one or more regression result files into a base result, then recompute
 * the summary with the same logic as the runner.
 *
 * Usage:
 *   node scripts/regression/merge-results.cjs \
 *     --base=docs/.../debate-regression-current-pool-parallel-latest.json \
 *     --add=docs/.../debate-regression-rubric-fix-a-latest.json,docs/.../b.json,c.json \
 *     --out=docs/.../debate-regression-current-pool-final-latest.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildSummary, markdown } = require('./summary.cjs');

function arg(name, fallback) {
  const found = process.argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const basePath = arg('base');
const addPaths = arg('add', '').split(',').map(item => item.trim()).filter(Boolean);
const outPath = arg('out');
if (!basePath || !outPath) throw new Error('需要 --base 与 --out');

const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const byId = new Map((base.results ?? []).map(item => [item.id, item]));
const corrections = [];
for (const file of addPaths) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const result of payload.results ?? []) {
    byId.set(result.id, result);
    corrections.push(result.id);
  }
}

const datasetPath = path.resolve(__dirname, 'debate-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const results = dataset.questions.map(item => byId.get(item.id)).filter(Boolean);
const summary = buildSummary(results);
const payload = {
  ...base,
  updatedAt: new Date().toISOString(),
  corrections: [...new Set(corrections)],
  summary,
  results
};
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2), 'utf8');
fs.writeFileSync(path.resolve(outPath).replace(/\.json$/, '.md'), markdown(summary, dataset, results), 'utf8');
console.log(JSON.stringify({ out: path.resolve(outPath), corrections: payload.corrections, summary }, null, 2));

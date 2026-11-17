#!/usr/bin/env node
/**
 * P3-E：真实模型 Pack 裁判回归（不是模拟 JSON 测试）。
 *
 * 用法：
 *   ./node_modules/.bin/electron scripts/regression/run-pack-judge-regression.cjs --no-sandbox
 *
 * 12 个冻结案例 × 3 次真实裁判调用；每个案例的期望关系来自数据集，
 * 不用模型 confidence 代替准确率。报告保留每次原始响应、解析结果、
 * 拒绝项、来源快照、耗时与用量。
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JudgeEngine } = require('../../out-test/main/judge/engine.js');
const { OpenAICompatibleProvider } = require('../../out-test/main/providers/openai-compatible.js');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const datasetArg = process.argv.find(item => item.startsWith('--dataset='));
const DATASET = datasetArg
  ? path.resolve(process.cwd(), datasetArg.slice('--dataset='.length))
  : path.join(__dirname, '..', '..', '..', 'docs', 'implementation', 'regression', 'pack-judge-regression-v1.json');
const OUT_DIR = path.dirname(DATASET);
const PROMPT_VERSION = 'p3f-1.1.0';
const FILE_PREFIX = 'pack-judge-regression-p3f';
const RUNS_PER_CASE = 3;
const TEMPERATURE = 0;
const SEED = 42;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function loadModels(appData) {
  const file = path.join(appData, 'thinkfusion-ai', 'execution-defaults.json');
  const defaults = JSON.parse(fs.readFileSync(file, 'utf8'));
  const models = [...new Set((defaults.selectedCloudModels ?? []).map(id => String(id).split(':').pop()))].filter(Boolean);
  if (models.length === 0) throw new Error('没有配置云端模型');
  return models;
}

function datasetOf() {
  const raw = fs.readFileSync(DATASET, 'utf8');
  const data = JSON.parse(raw);
  const actual = sha256(JSON.stringify(data.cases));
  if (actual !== data.sha256) throw new Error(`数据集 hash 不匹配：${data.sha256} / ${actual}`);
  for (const item of data.cases) {
    const fixture = sha256(JSON.stringify(item.evidence));
    if (fixture !== item.fixtureSha256) throw new Error(`${item.id} fixture hash 不匹配`);
  }
  return { data, rawSha: sha256(raw) };
}

function stateFor(item, commit) {
  const claim = {
    claimId: item.claim.id,
    messageId: `m-${item.id}`,
    agentId: 'a',
    roundIndex: 0,
    text: item.claim.text,
    kind: 'fact',
    kindCue: '陈述句',
    span: { messageId: `m-${item.id}`, start: 0, end: item.claim.text.length },
    assumptions: [],
    evidenceDrafts: [],
    status: 'proposed'
  };
  const evidence = item.evidence.map(entry => ({
    evidenceId: entry.evidenceId,
    origin: 'repo-snapshot',
    claimIds: [],
    kind: 'source-code',
    excerpt: entry.excerpt,
    span: { messageId: entry.evidenceId, start: 0, end: entry.excerpt.length },
    sourceId: `evidence-pack:${item.packId}`,
    messageId: entry.evidenceId,
    roundIndex: -1,
    url: `repo://${commit}/${entry.path}#L${entry.startLine}-L${entry.endLine}`,
    finalUrl: `repo://${commit}/${entry.path}#L${entry.startLine}-L${entry.endLine}`,
    fingerprint: `fp-${entry.itemId}`,
    originKey: `repo:${commit}`,
    independent: true,
    verified: 'snapshot',
    assessment: `来自冻结快照 ${commit.slice(0, 12)} ${entry.path}:${entry.startLine}-${entry.endLine}`,
    soleAttribution: false
  }));
  const links = item.evidence.filter(entry => entry.allowed).map(entry => ({
    debateId: `debate-${item.id}`,
    claimId: item.claim.id,
    evidenceId: entry.evidenceId,
    relation: 'context',
    source: 'pack',
    reason: `该主张引用了冻结快照 ${entry.path}:${entry.startLine}-${entry.endLine}`
  }));
  return {
    debateId: `debate-${item.id}`,
    question: item.question,
    repository: { root: process.cwd(), commit, branch: 'fixture', dirty: false },
    config: { strategy: 'truth', maxRounds: 1, participants: ['a', 'b'], convergenceStop: false },
    rounds: [{
      index: 0,
      phase: 'analysis',
      messages: [{
        messageId: `m-${item.id}`,
        roundIndex: 0,
        agentId: 'a',
        role: 'peer',
        kind: 'position',
        text: item.claim.text,
        createdAt: 1
      }],
      startedAt: 1,
      endedAt: 2,
      converged: false,
      failures: [],
      claims: [claim]
    }],
    minorities: [],
    disputes: [],
    evidence,
    packEvidence: evidence,
    packEvidenceLinks: links,
    createdAt: 1,
    updatedAt: 2
  };
}

function summarizeRun(item, verdict, rawCalls, durationMs, commit) {
  const allowed = new Set(item.evidence.filter(entry => entry.allowed).map(entry => entry.evidenceId));
  const accepted = verdict.packEvidence ?? [];
  const rejected = verdict.packEvidenceRejected ?? [];
  const primary = accepted.find(entry => entry.claimId === item.claim.id && allowed.has(entry.evidenceId)) ?? null;
  const forbiddenAccepted = accepted.filter(entry => item.expected.forbidden.includes(entry.relation));
  const invalidIds = accepted.filter(entry => !allowed.has(entry.evidenceId));
  const sourceMismatch = accepted.filter(entry =>
    entry.sourceSnapshot.packId !== item.packId || entry.sourceSnapshot.commit !== commit
  );
  const limitationsText = primary ? primary.limitations.join(' ') : '';
  const reasonText = primary ? primary.reason : '';
  const keywordHit = item.expected.limitationsKeywords.some(keyword =>
    limitationsText.includes(keyword) || reasonText.includes(keyword)
  );
  return {
    backend: verdict.backend,
    judgeMode: verdict.judgeMode ?? null,
    judgeIndependent: verdict.judgeIndependent ?? null,
    modelId: verdict.judgeModelId ?? null,
    judgeAttempts: verdict.judgeAttempts ?? null,
    fallbackReason: verdict.fallbackReason ?? null,
    durationMs,
    rawCalls,
    accepted,
    rejected,
    primaryRelation: primary?.relation ?? null,
    expectedRelation: item.expected.relation,
    relationCorrect: primary?.relation === item.expected.relation,
    forbiddenAccepted: forbiddenAccepted.map(entry => entry.relation),
    invalidIds: invalidIds.map(entry => entry.evidenceId),
    sourceMismatch: sourceMismatch.map(entry => entry.evidenceId),
    limitationsKeywordHit: keywordHit,
    usage: rawCalls.map(call => call.usage ?? null)
  };
}

function rate(n, d) {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

app.setName('ThinkFusion');
app.whenReady().then(async () => {
  const { data: dataset } = datasetOf();
  const models = loadModels(app.getPath('appData'));
  const keyFile = path.join(app.getPath('appData'), 'thinkfusion-ai', 'api-keys.json');
  const key = safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))['opencode-go'].cipher, 'base64'));
  const provider = new OpenAICompatibleProvider({
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: BASE,
    models,
    defaultModel: models[0],
    keyStore: { has: () => true, get: () => key },
    maxRetries: 0,
    timeoutMs: 240_000,
    extraHeaders: {
      'user-agent': 'thinkfusion-pack-judge-regression',
      'x-opencode-session': 'p3-regression'
    }
  });

  const startedAt = new Date().toISOString();
  const cases = [];
  for (const [caseIndex, item] of dataset.cases.entries()) {
    const judgeModel = models[caseIndex % models.length];
    const participants = models.filter(model => model !== judgeModel);
    const runs = [];
    console.log(`[${String(caseIndex + 1)}/${String(dataset.cases.length)}] ${item.id} · judge=${judgeModel}`);
    for (let run = 1; run <= RUNS_PER_CASE; run += 1) {
      const rawCalls = [];
      const ask = async (agentId, task) => {
        const response = await provider.generate({
          modelId: judgeModel,
          question: task.question,
          ...(task.system ? { system: task.system } : {}),
          ...(task.context ? { context: task.context } : {}),
          temperature: TEMPERATURE,
          seed: SEED,
          timeoutMs: 240_000
        });
        rawCalls.push({
          at: new Date().toISOString(),
          text: response.text,
          providerId: response.providerId,
          modelId: response.modelId,
          usage: response.usage ?? null,
          latencyMs: response.latencyMs ?? null
        });
        return {
          agentId,
          text: response.text,
          receivedAt: Date.now(),
          attribution: { requestId: `pack-judge-${item.id}-${String(run)}`, note: 'live regression' },
          stage: task.stage,
          usage: response.usage,
          providerId: response.providerId,
          modelId: response.modelId,
          latencyMs: response.latencyMs
        };
      };
      const engine = new JudgeEngine({
        ask,
        judgeAgentId: judgeModel,
        judgeModelId: judgeModel,
        judgeProviderId: 'opencode-go',
        participants,
        participantModelIds: participants
      });
      const state = stateFor(item, dataset.commit);
      const started = Date.now();
      let verdict;
      try {
        verdict = await engine.judge(state);
      } catch (error) {
        verdict = {
          backend: 'rules',
          judgeMode: 'rules-fallback',
          judgeIndependent: false,
          judgeModelId: judgeModel,
          judgeAttempts: rawCalls.length,
          fallbackReason: `脚本捕获异常：${error instanceof Error ? error.message : String(error)}`,
          packEvidence: [],
          packEvidenceRejected: []
        };
      }
      const summary = summarizeRun(item, verdict, rawCalls, Date.now() - started, dataset.commit);
      runs.push({ run, ...summary });
      console.log(`  run ${run}: backend=${summary.backend} relation=${summary.primaryRelation ?? '-'} expected=${summary.expectedRelation} correct=${summary.relationCorrect} rejected=${summary.rejected.length}`);
    }
    cases.push({
      caseId: item.id,
      packId: item.packId,
      fixtureSha256: item.fixtureSha256,
      judgeModel,
      expected: item.expected,
      runs
    });
  }

  const allRuns = cases.flatMap(item => item.runs);
  const modelRuns = allRuns.filter(run => run.backend === 'model');
  const expectedCounts = {};
  for (const item of cases) {
    const key = item.expected.relation;
    expectedCounts[key] = expectedCounts[key] ?? { total: 0, correct: 0 };
    expectedCounts[key].total += item.runs.length;
    expectedCounts[key].correct += item.runs.filter(run => run.relationCorrect).length;
  }
  const directionAccuracy = Object.fromEntries(
    Object.entries(expectedCounts).map(([key, value]) => [key, rate(value.correct, value.total)])
  );
  const consistency = cases.map(item => {
    const relations = item.runs.map(run => run.primaryRelation ?? 'none');
    return { caseId: item.caseId, relations, consistent: new Set(relations).size === 1 };
  });
  const metrics = {
    calls: allRuns.reduce((sum, run) => sum + run.rawCalls.length, 0),
    caseRuns: allRuns.length,
    modelBackend: modelRuns.length,
    modelSuccessRate: rate(modelRuns.length, allRuns.length),
    jsonFirstAttempt: rate(allRuns.filter(run => run.backend === 'model' && run.judgeAttempts === 1).length, allRuns.length),
    jsonFinalParse: rate(modelRuns.length, allRuns.length),
    fallbackRate: rate(allRuns.filter(run => run.backend === 'rules').length, allRuns.length),
    invalidIdAccepted: allRuns.reduce((sum, run) => sum + run.invalidIds.length, 0),
    forbiddenAccepted: allRuns.reduce((sum, run) => sum + run.forbiddenAccepted.length, 0),
    sourceMismatch: allRuns.reduce((sum, run) => sum + run.sourceMismatch.length, 0),
    directionAccuracy,
    consistencyRate: rate(consistency.filter(item => item.consistent).length, consistency.length),
    limitationsKeywordHitRate: rate(allRuns.filter(run => run.limitationsKeywordHit).length, allRuns.length),
    averageDurationMs: Math.round(allRuns.reduce((sum, run) => sum + run.durationMs, 0) / allRuns.length)
  };
  const finishedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const payload = {
    kind: 'pack-judge-regression',
    dataset: { version: dataset.version, sha256: dataset.sha256, commit: dataset.commit },
    environment: {
      provider: 'opencode-go',
      models,
      temperature: TEMPERATURE,
      seed: SEED,
      runsPerCase: RUNS_PER_CASE,
      promptVersion: PROMPT_VERSION,
      datasetFile: path.basename(DATASET),
      capturedAt: startedAt,
      finishedAt
    },
    cases,
    metrics,
    consistency
  };
  const jsonPath = path.join(OUT_DIR, `${FILE_PREFIX}-${stamp}.json`);
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  const shaPath = jsonPath.replace(/\.json$/, '.sha256');
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const md = [
    '# Pack Judge 真实模型回归',
    '',
    `- 数据集：${dataset.version} · \`${dataset.sha256.slice(0, 12)}…\``,
    `- 模型：${models.join('、')}`,
    `- 每次运行：${RUNS_PER_CASE} 次 × ${dataset.cases.length} 题`,
    `- 真实调用：${String(metrics.calls)} 次`,
    '',
    '## 指标',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 模型成功 | ${String(metrics.modelBackend)}/${String(metrics.caseRuns)}（${String(metrics.modelSuccessRate)}%） |`,
    `| 一次 JSON 成功 | ${String(metrics.jsonFirstAttempt)}% |`,
    `| 最终解析成功 | ${String(metrics.jsonFinalParse)}% |`,
    `| 回退规则版 | ${String(metrics.fallbackRate)}% |`,
    `| 非法 ID 接受 | ${String(metrics.invalidIdAccepted)} |`,
    `| 禁止方向接受 | ${String(metrics.forbiddenAccepted)} |`,
    `| 来源快照错配 | ${String(metrics.sourceMismatch)} |`,
    `| 方向一致率 | ${String(metrics.consistencyRate)}% |`,
    `| 限制关键词命中 | ${String(metrics.limitationsKeywordHitRate)}% |`,
    `| 平均耗时 | ${String(metrics.averageDurationMs)}ms |`,
    '',
    '## 方向准确率',
    '',
    ...Object.entries(directionAccuracy).map(([key, value]) => `- ${key}: ${String(value)}%`),
    '',
    '## 逐题',
    '',
    '| 题 | 期望 | run-1 | run-2 | run-3 | 一致 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...cases.map(item => {
      const relations = item.runs.map(run => run.primaryRelation ?? '-');
      const consistent = new Set(relations).size === 1 ? '是' : '否';
      return `| ${item.caseId} | ${item.expected.relation} | ${relations.join(' | ')} | ${consistent} |`;
    }),
    '',
    '> 这是真实模型调用；模拟 JSON 测试不进入本报告。'
  ].join('\n');
  fs.writeFileSync(mdPath, `${md}\n`, 'utf8');
  fs.writeFileSync(shaPath, `${sha256(fs.readFileSync(jsonPath))}  ${path.basename(jsonPath)}\n${sha256(fs.readFileSync(DATASET))}  ${path.basename(DATASET)}\n`, 'utf8');
  console.log(JSON.stringify(metrics));
  console.log(`WROTE ${jsonPath}`);
  const hardFailure = metrics.invalidIdAccepted > 0 || metrics.forbiddenAccepted > 0 || metrics.sourceMismatch > 0;
  app.exit(hardFailure ? 2 : 0);
}).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

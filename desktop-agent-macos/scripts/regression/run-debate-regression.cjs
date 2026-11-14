/**
 * 24 题自动回归：三模型轮换辩论 + 独立裁判 + P1/P2 质量报告。
 *
 * 规则：
 * - 每题只让其中两位辩论，第三位当裁判，因此裁判不参加该场辩论；
 * - 三个模型轮流当裁判，24 题里每位各判 8 题；
 * - 每题 2 轮，单次调用 180 秒，整场 300 秒；
 * - anchor 只是规则烟测，不是事实准确率；
 * - 任何一题失败都继续跑下一题，最后如实汇总。
 *
 * 运行前先 npm run build:test。
 * 用法：./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox
 */
const { app, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DebateStore } = require('../../out-test/main/debate/store.js');
const { DebateOrchestrator } = require('../../out-test/main/debate/orchestrator.js');
const { planLead } = require('../../out-test/main/debate/lead.js');
const { JudgeEngine } = require('../../out-test/main/judge/engine.js');
const { evaluateDebateQuality, finalizeDebate } = require('../../out-test/main/debate/quality-engine.js');
const { OpenAICompatibleProvider } = require('../../out-test/main/providers/openai-compatible.js');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODELS = [
  { id: 'deepseek', model: 'deepseek-v4.1-flash' },
  { id: 'gpt', model: 'gpt-6-luna' },
  { id: 'kimi', model: 'kimi-k2.7-code' }
];
const IDS = MODELS.map(item => item.id);
const DATASET_PATH = path.join(__dirname, 'debate-dataset.json');
const OUT_DIR = path.resolve(__dirname, '../../../docs/implementation/regression');
const STAGE_TIMEOUT_MS = 180_000;
const TOTAL_MS = 300_000;
const WAIT_MS = 380_000;
const JUDGE_TIMEOUT_MS = 240_000;

function loadDataset() {
  const raw = fs.readFileSync(DATASET_PATH, 'utf8');
  const dataset = JSON.parse(raw);
  const actual = crypto.createHash('sha256').update(JSON.stringify(dataset.questions)).digest('hex');
  if (actual !== dataset.sha256) {
    throw new Error(`数据集 hash 不匹配：文件 ${dataset.sha256}，实算 ${actual}`);
  }
  return dataset;
}

function anchorHit(text, anchor) {
  if (!anchor || !Array.isArray(anchor.terms)) return null;
  const lower = text.toLowerCase();
  const hits = anchor.terms.filter(term => lower.includes(String(term).toLowerCase()));
  return { checked: true, hit: hits.length > 0, hits, terms: anchor.terms, note: anchor.note };
}

function countBy(items, pick) {
  const out = {};
  for (const item of items) {
    const key = pick(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function buildSummary(results) {
  const completed = results.filter(item => item.debate.outcome === 'COMPLETED').length;
  const judgeModel = results.filter(item => item.judge.backend === 'model').length;
  const independent = results.filter(item => item.judge.backend === 'model' && !item.judge.sharedWith).length;
  const factual = countBy(results, item => item.quality?.factualAccuracy?.status ?? 'missing');
  const quality = countBy(results, item => item.quality?.status ?? 'missing');
  const anchors = results.filter(item => item.anchor?.checked);
  return {
    total: results.length,
    execution: countBy(results, item => item.debate.outcome ?? 'UNKNOWN'),
    completed,
    judgeModel,
    independent,
    sharedWith: results.filter(item => item.judge.sharedWith).length,
    quality,
    factual,
    anchors: {
      checked: anchors.length,
      hit: anchors.filter(item => item.anchor.hit).length
    },
    byStrategy: Object.fromEntries(
      [...new Set(results.map(item => item.strategy))].map(strategy => {
        const rows = results.filter(item => item.strategy === strategy);
        return [strategy, {
          total: rows.length,
          completed: rows.filter(item => item.debate.outcome === 'COMPLETED').length,
          judgeModel: rows.filter(item => item.judge.backend === 'model').length,
          independent: rows.filter(item => item.judge.backend === 'model' && !item.judge.sharedWith).length,
          avgDurationMs: Math.round(rows.reduce((sum, item) => sum + item.debate.durationMs, 0) / rows.length)
        }];
      })
    ),
    structuralOk: results.every(item =>
      item.debate.outcome === 'COMPLETED' &&
      item.judge.backend === 'model' &&
      !item.judge.sharedWith &&
      item.quality &&
      item.decision &&
      item.quality.factualAccuracy.status !== 'supported'
    )
  };
}

function markdown(summary, dataset, results) {
  const rows = results.map(item => [
    item.id,
    item.strategy,
    item.judge.agentId,
    item.debate.outcome,
    `${item.debate.rounds}/${item.debate.messages}`,
    item.judge.backend,
    item.quality?.status ?? 'missing',
    item.quality?.factualAccuracy?.status ?? 'missing',
    item.decision?.verdict ?? 'missing',
    item.decision?.action ?? 'missing',
    item.anchor?.checked ? (item.anchor.hit ? 'hit' : 'miss') : '-',
    `${Math.round(item.debate.durationMs / 1000)}s`
  ]);
  return [
    '# Debate V3 24 题自动回归结果',
    '',
    `- 数据集版本：\`${dataset.version}\``,
    `- 数据集 SHA-256：\`${dataset.sha256}\``,
    `- 生成时间：${new Date().toISOString()}`,
    `- 结构化通过：${summary.structuralOk ? '是' : '否'}`,
    `- 执行结果：${JSON.stringify(summary.execution)}`,
    `- 裁判：模型 ${summary.judgeModel}/${summary.total}，独立 ${summary.independent}/${summary.total}，sharedWith ${summary.sharedWith}`,
    `- 质量状态：${JSON.stringify(summary.quality)}`,
    `- 事实维度：${JSON.stringify(summary.factual)}`,
    `- anchor 烟测：${summary.anchors.hit}/${summary.anchors.checked}（不是事实准确率）`,
    '',
    '| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | anchor | 用时 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.join(' | ')} |`),
    '',
    '> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。',
    ''
  ].join('\n');
}

app.setName('ThinkFusion');
app.whenReady().then(async () => {
  const dataset = loadDataset();
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? Number.parseInt(limitArg.slice('--limit='.length), 10) : dataset.questions.length;
  const onlyArg = process.argv.find(arg => arg.startsWith('--only='));
  const only = onlyArg
    ? new Set(onlyArg.slice('--only='.length).split(',').map(item => item.trim()).filter(Boolean))
    : null;
  const suffixArg = process.argv.find(arg => arg.startsWith('--suffix='));
  const suffix = suffixArg
    ? `-${suffixArg.slice('--suffix='.length).replace(/[^a-zA-Z0-9_-]/g, '')}`
    : '';
  const mergeArg = process.argv.find(arg => arg.startsWith('--merge-into='));
  const mergeInto = mergeArg ? path.resolve(process.cwd(), mergeArg.slice('--merge-into='.length)) : null;
  const indexed = dataset.questions.map((item, datasetIndex) => ({ item, datasetIndex }));
  const filtered = only ? indexed.filter(entry => only.has(entry.item.id)) : indexed;
  if (only && filtered.length === 0) throw new Error(`--only 没有匹配的题：${[...only].join(',')}`);
  // 裁判按题在数据集里的固定位置轮换，不按“本次跑了第几个”轮换；
  // 只重跑一题时，仍然由原来那位裁判来判，结果才可比。
  const questions = filtered.slice(0, Number.isFinite(limit) && limit > 0 ? limit : filtered.length);
  console.log(`数据集 ${dataset.version} · ${dataset.sha256.slice(0, 12)}… · 本次 ${questions.length}/${dataset.questions.length} 题${suffix ? ` · 输出后缀 ${suffix}` : ''}`);
  const key = safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'thinkfusion-ai', 'api-keys.json'), 'utf8'))['opencode-go'].cipher, 'base64'));
  const provider = new OpenAICompatibleProvider({
    id: 'opencode-go', label: 'OpenCode Go', baseUrl: BASE,
    models: MODELS.map(item => item.model), defaultModel: MODELS[0].model,
    keyStore: { has: () => true, get: () => key },
    maxConcurrency: 3, maxRetries: 1, timeoutMs: JUDGE_TIMEOUT_MS,
    extraHeaders: { 'user-agent': 'thinkfusion-debate-regression', 'x-opencode-session': '24q-regression' }
  });
  const byId = new Map(MODELS.map(item => [item.id, item.model]));
  const candidates = MODELS.map(item => ({ id: item.id, label: item.model, type: 'cloud', available: true }));

  const askModel = async (agentId, task) => {
    const model = byId.get(agentId);
    if (!model) throw new Error(`没有模型映射：${agentId}`);
    const response = await provider.generate({
      modelId: model,
      question: task.question,
      ...(task.system ? { system: task.system } : {}),
      ...(task.context ? { context: task.context } : {}),
      timeoutMs: JUDGE_TIMEOUT_MS
    });
    return {
      agentId,
      text: response.text,
      receivedAt: Date.now(),
      stage: task.stage,
      attribution: { requestId: '24q-regression', note: 'configured model' },
      usage: response.usage,
      providerId: 'opencode-go',
      modelId: model,
      latencyMs: response.latencyMs
    };
  };

  const results = [];
  for (let index = 0; index < questions.length; index += 1) {
    const { item, datasetIndex } = questions[index];
    const judgeAgentId = IDS[datasetIndex % IDS.length];
    const debaters = IDS.filter(id => id !== judgeAgentId);
    const startedAt = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tf-regression-${item.id}-`));
    const store = new DebateStore(dir);
    const orchestrator = new DebateOrchestrator(store, { ask: askModel });
    let state = null;
    let timedOut = false;
    let error = null;
    let judgeUsage = null;
    let judgeLatencyMs = null;
    let verdict = null;
    let quality = null;
    let decision = null;

    console.log(`[${index + 1}/${questions.length}] ${item.id} · ${item.strategy} · 辩论 ${debaters.join('+')} · 裁判 ${judgeAgentId}`);
    try {
      const plan = planLead({
        mode: 'cloud',
        strategy: item.strategy,
        candidates,
        selected: debaters
      });
      const started = orchestrator.start(item.question, {
        strategy: item.strategy,
        maxRounds: 2,
        participants: debaters,
        convergenceStop: false,
        leadMode: 'cloud',
        budget: {
          stageTimeoutMs: STAGE_TIMEOUT_MS,
          totalMs: TOTAL_MS,
          maxConcurrency: 2
        }
      }, undefined, plan);
      state = await orchestrator.waitFor(started.debateId, WAIT_MS);
      if (!state) throw new Error('辩论没有返回状态');
      timedOut = state.status === 'running';
      if (timedOut) {
        orchestrator.stop(started.debateId);
        state = orchestrator.get(started.debateId) ?? state;
      }

      const engine = new JudgeEngine({
        judgeAgentId,
        sharedWith: state.plan.participants.includes(judgeAgentId) ? judgeAgentId : undefined,
        ask: async (agentId, task) => {
          const answer = await askModel(agentId, task);
          judgeUsage = answer.usage ?? null;
          judgeLatencyMs = answer.latencyMs ?? null;
          return answer;
        }
      });
      verdict = await engine.judge(state);
      quality = evaluateDebateQuality({
        state,
        verdict,
        modelAssessed: verdict.backend === 'model'
      });
      decision = finalizeDebate(state, verdict, quality);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const messages = state?.rounds.flatMap(round => round.messages) ?? [];
    const combinedText = [
      ...messages.map(message => message.text),
      verdict?.conclusion ?? ''
    ].join('\n');
    results.push({
      id: item.id,
      category: item.category,
      strategy: item.strategy,
      question: item.question,
      judge: {
        agentId: judgeAgentId,
        modelId: byId.get(judgeAgentId),
        backend: verdict?.backend ?? 'missing',
        judgeAttempts: verdict?.judgeAttempts ?? null,
        questionType: verdict?.questionType ?? null,
        sharedWith: verdict?.sharedWith ?? null,
        undetermined: verdict?.undetermined ?? null,
        confidence: verdict?.confidence?.level ?? null,
        fallbackReason: verdict?.fallbackReason ?? null,
        usage: judgeUsage,
        latencyMs: judgeLatencyMs
      },
      debate: {
        status: state?.status ?? 'missing',
        outcome: state?.outcome ?? (error ? 'FAILED' : timedOut ? 'CANCELLED' : 'UNKNOWN'),
        rounds: state?.rounds.length ?? 0,
        messages: messages.length,
        failures: state?.rounds.flatMap(round => round.failures) ?? [],
        stopReason: state?.stopReason ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
        durationSec: Math.round((Date.now() - startedAt) / 1000),
        usage: messages.map(message => ({
          agentId: message.agentId,
          modelId: message.modelId,
          inputTokens: message.usage?.inputTokens ?? null,
          outputTokens: message.usage?.outputTokens ?? null
        }))
      },
      quality: quality
        ? {
            status: quality.status,
            modelAssessed: quality.modelAssessed,
            factualAccuracy: quality.dimensions.factualAccuracy,
            logicalValidity: quality.dimensions.logicalValidity,
            evidenceQuality: quality.dimensions.evidenceQuality,
            uncertaintyCalibration: quality.dimensions.uncertaintyCalibration,
            conclusionConsistency: quality.dimensions.conclusionConsistency,
            criticalIssues: quality.criticalIssues,
            rule: { passed: quality.rule.passed, total: quality.rule.total, ok: quality.rule.ok }
          }
        : null,
      decision: decision
        ? {
            verdict: decision.verdict,
            action: decision.action,
            conclusion: decision.conclusion ? decision.conclusion.slice(0, 500) : null,
            unresolvedDisputes: decision.unresolvedDisputes,
            uncertainty: decision.uncertainty,
            recommendedFollowUp: decision.recommendedFollowUp ?? null
          }
        : null,
      anchor: anchorHit(combinedText, item.anchor),
      error
    });
    console.log(`    -> ${results[results.length - 1].debate.outcome} · judge=${verdict?.backend ?? 'missing'} · quality=${quality?.status ?? 'missing'} · ${Math.round((Date.now() - startedAt) / 1000)}s`);

    // 每题结束就落一份 latest，长跑被中断时不丢已经跑完的记录。
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const partial = {
      dataset: { version: dataset.version, sha256: dataset.sha256, note: dataset.note },
      models: MODELS.map(model => model.model),
      judgeRotation: IDS,
      createdAt: new Date().toISOString(),
      summary: buildSummary(results),
      results
    };
    fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-latest.json`), JSON.stringify(partial, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-latest.md`), markdown(buildSummary(results), dataset, results), 'utf8');
  }

  const summary = buildSummary(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    dataset: { version: dataset.version, sha256: dataset.sha256, note: dataset.note },
    models: MODELS.map(item => item.model),
    judgeRotation: IDS,
    createdAt: new Date().toISOString(),
    summary,
    results
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const latest = path.join(OUT_DIR, `debate-regression${suffix}-latest.json`);
  fs.writeFileSync(latest, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-${stamp}.json`), JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-latest.md`), markdown(summary, dataset, results), 'utf8');
  if (mergeInto) {
    const existing = JSON.parse(fs.readFileSync(mergeInto, 'utf8'));
    const byId = new Map((existing.results ?? []).map(item => [item.id, item]));
    for (const item of results) byId.set(item.id, item);
    const merged = dataset.questions.map(item => byId.get(item.id)).filter(Boolean);
    const mergedPayload = {
      ...existing,
      updatedAt: new Date().toISOString(),
      summary: buildSummary(merged),
      results: merged
    };
    fs.writeFileSync(mergeInto, JSON.stringify(mergedPayload, null, 2), 'utf8');
    fs.writeFileSync(mergeInto.replace(/\.json$/, '.md'), markdown(mergedPayload.summary, dataset, merged), 'utf8');
    console.log(`MERGED ${mergeInto} · ${merged.length}/${dataset.questions.length}`);
  }
  console.log(`DONE ${JSON.stringify(summary)}`);
  app.exit(summary.structuralOk ? 0 : 2);
}).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

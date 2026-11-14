/**
 * 24 题自动回归：单进程 worker 池 + 三模型轮换辩论 + 独立裁判 + V1 评分。
 *
 * 规则：
 * - 每题只让其中两位辩论，第三位当裁判，因此裁判不参加该场辩论；
 * - 三个模型轮流当裁判，24 题里每位各判 8 题；
 * - 每题 2 轮，单次调用 180 秒，整场 300 秒；
 * - worker 是同一进程里的异步任务，不是多个 Electron 进程；
 * - anchor 只是规则烟测，不是事实准确率；
 * - 任何一题失败都继续跑下一题，最后如实汇总。
 *
 * 运行前先 npm run build:test。
 * 并行：--workers=3；默认 1（串行）。
 * 增量：--incremental=<旧 latest.json>；只重跑缺题、失败题和 fingerprint 变了的题。
 * 用法：./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox --workers=3
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
const { assessStandardAnswer } = require('../../out-test/main/debate/standard-rubric.js');
const { OpenAICompatibleProvider } = require('../../out-test/main/providers/openai-compatible.js');
const { PROMPT_VERSION } = require('../../out-test/main/debate/prompts.js');
const { buildSummary, markdown } = require('./summary.cjs');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const DATASET_PATH = path.join(__dirname, 'debate-dataset.json');
const STANDARD_PATH = path.join(__dirname, 'debate-standard-answers-v1.json');
const OUT_DIR = path.resolve(__dirname, '../../../docs/implementation/regression');
const STAGE_TIMEOUT_MS = 180_000;
const TOTAL_MS = 300_000;
const WAIT_MS = 380_000;
const JUDGE_TIMEOUT_MS = 240_000;
const RUNNER_VERSION = '2.0.0';

/**
 * 每题指纹：只包含会影响这一题结果的东西。标准答案按题取，
 * 所以改一题的标准只会让这一题失效；改全局 prompt/模型池会让全部失效。
 */
function fingerprint(item, standardItem) {
  return crypto.createHash('sha256').update(JSON.stringify({
    runnerVersion: RUNNER_VERSION,
    promptVersion: PROMPT_VERSION,
    question: item.question,
    strategy: item.strategy,
    anchor: item.anchor ?? null,
    standard: standardItem ?? null,
    models: MODELS.map(model => model.model)
  })).digest('hex');
}

let MODELS = [];
let IDS = [];

/** 读取用户在设置里勾选的模型；不把模型名硬编码在回归脚本里。 */
function loadSelectedModels(appData) {
  const file = path.join(appData, 'thinkfusion-ai', 'execution-defaults.json');
  const defaults = JSON.parse(fs.readFileSync(file, 'utf8'));
  const selected = Array.isArray(defaults.selectedCloudModels) ? defaults.selectedCloudModels : [];
  const models = [...new Set(selected.map(id => String(id).split(':').pop()).filter(Boolean))];
  if (models.length < 2) throw new Error('至少需要在设置里勾选两个云端模型');
  return models.map(model => ({ id: model, model }));
}

function loadDataset() {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
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

function argValue(name, fallback) {
  const found = process.argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

app.setName('ThinkFusion');
app.whenReady().then(async () => {
  MODELS = loadSelectedModels(app.getPath('appData'));
  IDS = MODELS.map(item => item.id);
  console.log(`模型池：${MODELS.map(item => item.model).join('、')}`);

  const dataset = loadDataset();
  const standard = JSON.parse(fs.readFileSync(STANDARD_PATH, 'utf8'));
  const standardHash = crypto.createHash('sha256').update(JSON.stringify(standard.questions)).digest('hex');
  if (standardHash !== standard.sha256) {
    throw new Error(`标准答案 hash 不匹配：文件 ${standard.sha256}，实算 ${standardHash}`);
  }
  const standardById = new Map(standard.questions.map(item => [item.id, item]));

  const limit = Number.parseInt(argValue('limit', String(dataset.questions.length)), 10);
  const onlyArg = argValue('only', '');
  const only = onlyArg
    ? new Set(onlyArg.split(',').map(item => item.trim()).filter(Boolean))
    : null;
  const suffixArg = argValue('suffix', '');
  const suffix = suffixArg
    ? `-${suffixArg.replace(/[^a-zA-Z0-9_-]/g, '')}`
    : '';
  const mergeArg = argValue('merge-into', '');
  const mergeInto = mergeArg ? path.resolve(process.cwd(), mergeArg) : null;
  const incrementalArg = argValue('incremental', '');
  const incrementalPath = incrementalArg ? path.resolve(process.cwd(), incrementalArg) : null;
  const workers = Math.max(1, Math.min(8, Number.parseInt(argValue('workers', '1'), 10) || 1));
  const providerConcurrency = Math.max(
    1,
    Math.min(12, Number.parseInt(argValue('provider-concurrency', String(Math.max(3, workers * 2))), 10))
  );

  const indexed = dataset.questions.map((item, datasetIndex) => ({ item, datasetIndex }));
  const filtered = only ? indexed.filter(entry => only.has(entry.item.id)) : indexed;
  if (only && filtered.length === 0) throw new Error(`--only 没有匹配的题：${[...only].join(',')}`);
  // 裁判按题在数据集里的固定位置轮换，不按“本次跑了第几个”轮换；
  // 只重跑一题时，仍然由原来那位裁判来判，结果才可比。
  const questions = filtered.slice(0, Number.isFinite(limit) && limit > 0 ? limit : filtered.length);
  console.log(
    `数据集 ${dataset.version} · ${dataset.sha256.slice(0, 12)}… · 本次 ${questions.length}/${dataset.questions.length} 题` +
    `${suffix ? ` · 输出后缀 ${suffix}` : ''} · workers=${workers} · providerConcurrency=${providerConcurrency}`
  );

  const key = safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(
    path.join(app.getPath('appData'), 'thinkfusion-ai', 'api-keys.json'), 'utf8'
  ))['opencode-go'].cipher, 'base64'));
  const provider = new OpenAICompatibleProvider({
    id: 'opencode-go', label: 'OpenCode Go', baseUrl: BASE,
    models: MODELS.map(item => item.model), defaultModel: MODELS[0].model,
    keyStore: { has: () => true, get: () => key },
    maxConcurrency: providerConcurrency, maxRetries: 1, timeoutMs: JUDGE_TIMEOUT_MS,
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

  async function runQuestion(entry, position, workerId) {
    const { item, datasetIndex } = entry;
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
    let standardAssessment = null;
    let rubricAgentId = null;

    console.log(`[w${workerId}] [${position + 1}/${questions.length}] ${item.id} · ${item.strategy} · 辩论 ${debaters.join('+')} · 裁判 ${judgeAgentId}`);
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
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不影响结果记录。
      }
    }

    const messages = state?.rounds.flatMap(round => round.messages) ?? [];
    const combinedText = [
      ...messages.map(message => message.text),
      verdict?.conclusion ?? ''
    ].join('\n');
    const standardItem = standardById.get(item.id);
    if (standardItem) {
      rubricAgentId = IDS.find(id => id !== judgeAgentId) ?? judgeAgentId;
      standardAssessment = await assessStandardAnswer({
        item: standardItem,
        answerText: decision?.conclusion ?? combinedText,
        ask: askModel,
        agentId: rubricAgentId
      });
    }

    const result = {
      id: item.id,
      category: item.category,
      strategy: item.strategy,
      question: item.question,
      fingerprint: fingerprint(item, standardItem),
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
      standard: standardAssessment && standardItem
        ? {
            id: standardItem.id,
            classification: standardItem.classification,
            ...standardAssessment,
            rubricAgentId,
            participatedInDebate: Boolean(state?.plan?.participants?.includes(rubricAgentId))
          }
        : null,
      anchor: anchorHit(combinedText, item.anchor),
      error
    };
    console.log(`[w${workerId}] [${position + 1}/${questions.length}] -> ${result.debate.outcome} · judge=${verdict?.backend ?? 'missing'} · quality=${quality?.status ?? 'missing'} · V1=${standardAssessment?.passed ? 'pass' : standardAssessment ? 'fail' : '-'} · ${result.debate.durationSec}s`);
    return result;
  }

  const baseline = incrementalPath && fs.existsSync(incrementalPath)
    ? JSON.parse(fs.readFileSync(incrementalPath, 'utf8'))
    : null;
  const baselineById = new Map((baseline?.results ?? []).map(item => [item.id, item]));
  const slots = new Array(questions.length).fill(null);
  const pending = [];
  questions.forEach((entry, position) => {
    const standardItem = standardById.get(entry.item.id);
    const currentFingerprint = fingerprint(entry.item, standardItem);
    const old = baselineById.get(entry.item.id);
    // 老结果没有 fingerprint 时，用当前题目的组成反算一次；这兼容严格修复前的记录。
    const oldFingerprint = old?.fingerprint ?? (old ? fingerprint(entry.item, standardItem) : null);
    const canReuse = Boolean(
      old &&
      oldFingerprint === currentFingerprint &&
      old.debate?.outcome === 'COMPLETED' &&
      old.standard?.passed === true
    );
    if (canReuse) slots[position] = { ...old, fingerprint: currentFingerprint, reused: true };
    else pending.push({ entry, position });
  });
  console.log(`增量：复用 ${questions.length - pending.length} 题，重跑 ${pending.length} 题${incrementalPath ? `（baseline: ${incrementalPath}）` : ''}`);

  const writeLatest = () => {
    const current = slots.filter(Boolean);
    const summary = buildSummary(current);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const partial = {
      dataset: { version: dataset.version, sha256: dataset.sha256, note: dataset.note },
      models: MODELS.map(model => model.model),
      judgeRotation: IDS,
      createdAt: new Date().toISOString(),
      workers,
      incremental: incrementalPath ? {
        baseline: incrementalPath,
        reused: questions.length - pending.length,
        pending: pending.length
      } : null,
      summary,
      results: current
    };
    fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-latest.json`), JSON.stringify(partial, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-latest.md`), markdown(summary, dataset, current), 'utf8');
  };
  if (slots.some(Boolean)) writeLatest();

  let cursor = 0;
  const runWorker = async workerId => {
    for (;;) {
      const pendingIndex = cursor;
      cursor += 1;
      if (pendingIndex >= pending.length) return;
      const { entry, position } = pending[pendingIndex];
      try {
        slots[position] = await runQuestion(entry, position, workerId);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        console.error(`[w${workerId}] 题目 ${entry.item.id} 未捕获错误：${message}`);
        slots[position] = {
          id: entry.item.id,
          category: entry.item.category,
          strategy: entry.item.strategy,
          question: entry.item.question,
          fingerprint: fingerprint(entry.item, standardById.get(entry.item.id)),
          judge: { agentId: null, backend: 'missing', sharedWith: null },
          debate: { outcome: 'FAILED', rounds: 0, messages: 0, failures: [], durationMs: 0, durationSec: 0 },
          quality: null,
          decision: null,
          standard: null,
          anchor: null,
          error: message
        };
      }
      writeLatest();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(workers, pending.length) }, (_, index) => runWorker(index + 1))
  );

  const results = slots.filter(Boolean);
  const summary = buildSummary(results);
  const createdAt = new Date().toISOString();
  const payload = {
    dataset: { version: dataset.version, sha256: dataset.sha256, note: dataset.note },
    models: MODELS.map(item => item.model),
    judgeRotation: IDS,
    createdAt,
    workers,
    incremental: incrementalPath ? {
      baseline: incrementalPath,
      reused: questions.length - pending.length,
      pending: pending.length
    } : null,
    summary,
    results
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const latest = path.join(OUT_DIR, `debate-regression${suffix}-latest.json`);
  fs.writeFileSync(latest, JSON.stringify(payload, null, 2), 'utf8');
  const stamp = createdAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-${stamp}.json`), JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-latest.md`), markdown(summary, dataset, results), 'utf8');
  if (mergeInto) {
    const existing = JSON.parse(fs.readFileSync(mergeInto, 'utf8'));
    const existingById = new Map((existing.results ?? []).map(item => [item.id, item]));
    for (const item of results) existingById.set(item.id, item);
    const merged = dataset.questions.map(item => existingById.get(item.id)).filter(Boolean);
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

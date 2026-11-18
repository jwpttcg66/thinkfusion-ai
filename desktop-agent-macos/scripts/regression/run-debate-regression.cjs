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
const { adjudicateDebate } = require('../../out-test/main/judge/adjudicate.js');
const { assessStandardAnswer } = require('../../out-test/main/debate/standard-rubric.js');
const { reviewCompleteness, reviseAnswer } = require('../../out-test/main/debate/completeness.js');
const { OpenAICompatibleProvider } = require('../../out-test/main/providers/openai-compatible.js');
const { buildSummary, markdown } = require('./summary.cjs');
const { RETRY_POLICY_VERSION, withRetryPolicy, retryPolicySnapshot } = require('./retry-policy.cjs');
const { buildBaselineStats, markdownBaseline } = require('./baseline-stats.cjs');
const { fingerprintFor, canReuseResult } = require('./incremental.cjs');
const { execFile } = require('node:child_process');
const { parseCliResultJson, isStructuredCliSuccess } = require('../../out-test/shared/cli-result.js');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const DATASET_PATH = path.join(__dirname, 'debate-dataset.json');
const STANDARD_PATH = path.join(__dirname, 'debate-standard-answers-v1.json');
const OUT_DIR = path.resolve(__dirname, '../../../docs/implementation/regression');
/**
 * 时间预算。
 *
 * 默认值是按云端 Provider 的直连延迟定的（单次十几秒）。CLI 档慢一个量级
 * ——同一段辩论提示下实测 DeepSeek-Flash 29s、Qwen3.8-Flash 16s、
 * GLM-5.3-Flash 108s，300 秒的整场预算只够跑两轮里的两条消息，辩论会被判
 * PARTIAL。所以预算改成可配置，CLI 档由命令行给足，不把默认值改大：
 * 改默认值会让云端档的历史结果与本次结果不可比。
 */
const STAGE_TIMEOUT_MS = Math.max(30_000, Number.parseInt(argValue('stage-ms', '180000'), 10) || 180_000);
const TOTAL_MS = Math.max(60_000, Number.parseInt(argValue('total-ms', '300000'), 10) || 300_000);
const WAIT_MS = Math.max(TOTAL_MS, Number.parseInt(argValue('wait-ms', '380000'), 10) || 380_000);
const JUDGE_TIMEOUT_MS = 240_000;
/**
 * 2.1.0：裁决改走 `adjudicateDebate`（与 IPC 同一条链，含失败换人）。
 *
 * 顺带把旧指纹全部作废。这个常量不含代码 SHA，忘了 bump 就带
 * `--incremental` 跑，会把上一版的结果原样复用成「本次结果」，报告看起来
 * 却是新生成的——那一版证据比不跑更糟。
 */
const RUNNER_VERSION = '2.3.0';

/**
 * 每题指纹：只包含会影响这一题结果的东西。标准答案按题取，
 * 所以改一题的标准只会让这一题失效；改全局 prompt/模型池会让全部失效。
 */
function fingerprint(item, standardItem) {
  return fingerprintFor({
    runnerVersion: RUNNER_VERSION,
    promptVersion: 'none',
    item,
    standardItem,
    models: MODELS.map(model => model.model),
    completeness: completenessEnabled
  });
}

let MODELS = [];
let IDS = [];
let completenessEnabled = false;

/**
 * 模型从哪来。
 *
 * `provider`（缺省）= 设置里勾选的云端模型，走 OpenCode Go 一个 Provider。
 * `cli` = qoder CLI，一个模型一个 `-m`，额度/鉴权/模型池都与云端 Provider 无关。
 *
 * **换后端就是换口径**：qoder 的模型名跟历史 18/24 那三个（deepseek-v4.1-flash /
 * gpt-6-luna / claude-haiku-5-5）不是同一批，`compare-results.cjs` 会因此拒绝
 * 给逐题差异。这是它该做的事——两份结果不是同一把尺子量出来的。
 */
const BACKEND = argValue('backend', 'provider');
const CLI_MODEL_NAMES = (argValue('models', '') || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);
const CLI_BIN = argValue('cli-bin', path.join(process.env.HOME ?? '', '.qoder', 'entry', 'qoder'));
/**
 * 经济模式（`--economy`）：把 CLI 自己的思考预算关掉，并关掉会话落盘。
 *
 * 这一档省的是 qoder 侧的 token 与会话文件，改的不是辩论流程——成员、裁判轮换、
 * 阶段一条都不动。代价是模型少了「先想后答」，同一道题的答案深度会低于开思考的
 * 跑法，**两种跑法的分数不能混着比**，所以报告里如实记 `runner.economy`。
 */
const ECONOMY = process.argv.includes('--economy') || argValue('economy', '0') === '1';

/**
 * P0 基线冻结的固定口径。
 *
 * `--runs` 默认 3：单次 24 题会被模型随机性带偏，18 和 19 都出现过。
 * `--temperature` 固定 0；`--seed` 只有在探测确认 Provider 接受后才发送，
 * 探测失败就如实记 unsupported，不伪造可复现。
 */
const RUNS = Math.max(1, Math.min(5, Number.parseInt(argValue('runs', '3'), 10) || 3));
const TEMPERATURE = Number.parseFloat(argValue('temperature', '0'));
const SEED_VALUE = Number.parseInt(argValue('seed', '42'), 10);
const BASELINE_TAG = argValue('tag', '').trim() || null;

/** 读取用户在设置里勾选的模型；不把模型名硬编码在回归脚本里。 */
function loadSelectedModels(appData) {
  const file = path.join(appData, 'thinkfusion-ai', 'execution-defaults.json');
  const defaults = JSON.parse(fs.readFileSync(file, 'utf8'));
  const selected = Array.isArray(defaults.selectedCloudModels) ? defaults.selectedCloudModels : [];
  const models = [...new Set(selected.map(id => String(id).split(':').pop()).filter(Boolean))];
  if (models.length < 2) throw new Error('至少需要在设置里勾选两个云端模型');
  return models.map(model => ({ id: model, model }));
}

/**
 * 本次用哪套模型。
 *
 * CLI 档的 id 由模型名派生（`GLM-5.3-Flash` → `glm-5-3-flash`），这样
 * `planLead` / 辩论成员 / 裁判轮换仍然按 id 走，不用为 CLI 单独写一套选人逻辑。
 */
function loadModelPool(appData) {
  if (BACKEND !== 'cli') return loadSelectedModels(appData);
  if (CLI_MODEL_NAMES.length < 2) {
    throw new Error('--backend=cli 时要用 --models= 至少给两个模型名（见 qoder --list-models）');
  }
  return CLI_MODEL_NAMES.map(name => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    model: name
  }));
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

/**
 * 本次跑的是哪份代码。
 *
 * 报告必须能自证「这是当前提交跑出来的」：`RUNNER_VERSION` 是手写常量，
 * 指纹里也没有 SHA，只靠它挡不住「复用旧结果」。写进报告，事后能对。
 */
/** 报告与数据集的侧车 hash：报告本身写不了自己的 hash，只能另写一行。 */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function codeSha() {
  try {
    return require('node:child_process')
      .execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '../../..'), encoding: 'utf8' })
      .trim();
  } catch {
    return null;
  }
}

/**
 * 采样能力探测。
 *
 * 只做一次，用最小请求（max_tokens=16）确认网关是否接受 temperature/seed。
 * 200 只证明「接受字段」，不能证明 seed 真的决定了输出——这个区别写进报告，
 * 不能把 accepted 当成 enforced。
 */
async function probeSampling({ baseUrl, key, model }) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    'user-agent': 'thinkfusion-debate-regression',
    'x-opencode-session': 'p0-sampling-probe'
  };
  const call = async extra => {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          max_tokens: 16,
          ...extra
        })
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text: text.slice(0, 300) };
    } catch (error) {
      return { status: 0, ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  };
  const supportOf = (result, value) => {
    if (result.ok) return { value, support: 'accepted', enforcement: 'unverified' };
    if (result.status === 400) return { value, support: 'unsupported', detail: result.text };
    return { value, support: 'unverified', detail: `probe ${result.status || 'network'}: ${result.text}` };
  };

  const both = await call({ temperature: TEMPERATURE, seed: SEED_VALUE });
  if (both.ok) {
    return {
      temperature: { value: TEMPERATURE, support: 'accepted', enforcement: 'unverified' },
      seed: { value: SEED_VALUE, support: 'accepted', enforcement: 'unverified' },
      evidence: ['temperature+seed accepted in one probe'],
      requests: 1
    };
  }
  if (both.status !== 400) {
    return {
      temperature: { value: TEMPERATURE, support: 'unverified', detail: both.text },
      seed: { value: SEED_VALUE, support: 'unverified', detail: both.text },
      evidence: [`combined probe failed with ${both.status || 'network'}`],
      requests: 1
    };
  }

  const tempOnly = await call({ temperature: TEMPERATURE });
  const seedOnly = await call({ seed: SEED_VALUE });
  return {
    temperature: supportOf(tempOnly, TEMPERATURE),
    seed: supportOf(seedOnly, SEED_VALUE),
    evidence: ['combined probe rejected with 400; tested separately'],
    requests: 3
  };
}

/** 采样开关在探测后确定；报告里必须能看出「发送了」还是「不支持」。 */
let temperatureEnabled = false;
let seedAccepted = false;
let samplingSnapshot = {
  temperature: { value: null, support: 'unsupported' },
  seed: { value: null, support: 'unsupported' },
  evidence: ['not probed'],
  requests: 0
};

/** 每次重试都记在这里；不记录请求内容，只记录模型、错误类别和等待时间。 */
const retryEvents = [];
let currentRunRetryStart = 0;

app.setName('ThinkFusion');
app.whenReady().then(async () => {
  MODELS = loadModelPool(app.getPath('appData'));
  IDS = MODELS.map(item => item.id);
  console.log(`模型池（${BACKEND}）：${MODELS.map(item => item.model).join('、')}`);

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
  completenessEnabled = process.argv.includes('--completeness') || argValue('completeness', '0') === '1';

  const indexed = dataset.questions.map((item, datasetIndex) => ({ item, datasetIndex }));
  const filtered = only ? indexed.filter(entry => only.has(entry.item.id)) : indexed;
  if (only && filtered.length === 0) throw new Error(`--only 没有匹配的题：${[...only].join(',')}`);
  // 裁判按题在数据集里的固定位置轮换，不按“本次跑了第几个”轮换；
  // 只重跑一题时，仍然由原来那位裁判来判，结果才可比。
  const questions = filtered.slice(0, Number.isFinite(limit) && limit > 0 ? limit : filtered.length);
  console.log(
    `数据集 ${dataset.version} · ${dataset.sha256.slice(0, 12)}… · 本次 ${questions.length}/${dataset.questions.length} 题` +
    `${suffix ? ` · 输出后缀 ${suffix}` : ''} · workers=${workers} · providerConcurrency=${providerConcurrency}` +
    `${ECONOMY ? ' · 经济模式（--thinking disabled）' : ''}`
  );

  // CLI 档不读云端 Key，也不建 Provider：qoder 自己管鉴权。
  let provider = null;
  let apiKey = null;
  if (BACKEND !== 'cli') {
    apiKey = safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(
      path.join(app.getPath('appData'), 'thinkfusion-ai', 'api-keys.json'), 'utf8'
    ))['opencode-go'].cipher, 'base64'));
    provider = new OpenAICompatibleProvider({
      id: 'opencode-go', label: 'OpenCode Go', baseUrl: BASE,
      models: MODELS.map(item => item.model), defaultModel: MODELS[0].model,
      keyStore: { has: () => true, get: () => apiKey },
      // 重试由回归自己的策略层负责，Provider 不再重试：两层重试会让
      // 「尝试次数」和「退避时间」在报告里对不上。
      maxConcurrency: providerConcurrency, maxRetries: 0, timeoutMs: JUDGE_TIMEOUT_MS,
      extraHeaders: { 'user-agent': 'thinkfusion-debate-regression', 'x-opencode-session': '24q-regression' }
    });
    samplingSnapshot = await probeSampling({ baseUrl: BASE, key: apiKey, model: MODELS[0].model });
    temperatureEnabled = samplingSnapshot.temperature.support === 'accepted';
    seedAccepted = samplingSnapshot.seed.support === 'accepted';
    console.log(
      `采样探测：temperature=${samplingSnapshot.temperature.support} · seed=${samplingSnapshot.seed.support}` +
      `（${samplingSnapshot.temperature.support === 'unsupported' ? '不发送' : '发送'}）`
    );
  } else {
    samplingSnapshot = {
      temperature: { value: null, support: 'unsupported' },
      seed: { value: null, support: 'unsupported' },
      evidence: ['CLI backend does not expose sampling options'],
      requests: 0
    };
  }
  const providerId = BACKEND === 'cli' ? 'qoder-cli' : 'opencode-go';
  const byId = new Map(MODELS.map(item => [item.id, item.model]));
  const candidates = MODELS.map(item => ({ id: item.id, label: item.model, type: 'cloud', available: true }));
  // 裁决候选：三个模型全在池里，`preferredJudgeId` 指定本题轮换到的那位。
  // 它没参辩，所以会被选成独立裁判；万一调用失败，adjudicateDebate 会换人，
  // 而不是像以前那样直接把规则版当结果。
  const judgeCandidates = MODELS.map(item => ({
    id: item.id,
    label: item.model,
    type: 'cloud',
    available: true,
    modelId: item.model,
    providerId
  }));

  /**
   * 问一次 qoder CLI（`-m` 指定模型、`-p` 无头、`--output-format json`）。
   *
   * 与 Provider 档的三处差别，写在明处而不是假装一样：
   * 1. 消息压成一段文本（system → 上下文 → 问题）。Provider 是多条结构化
   *    messages，CLI 只有一个 `-p` 入口；
   * 2. 答案经过 qoder 自己的 agent 外壳，不保证等于裸模型输出；
   * 3. cwd 固定在临时目录——回答链不该碰本仓文件。
   */
  function askQoderCli(agentId, model, task) {
    const prompt = [...(task.system ?? []), ...(task.context ?? []), task.question]
      .filter(text => typeof text === 'string' && text.trim())
      .join('\n\n');
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '-m', model, '--output-format', 'json'];
      if (ECONOMY) args.push('--thinking', 'disabled', '--no-session-persistence');
      execFile(
        CLI_BIN,
        args,
        { cwd: os.tmpdir(), timeout: JUDGE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => {
          // 超时/非零退出也先看 stdout：qoder 有时把结果打完才非零退出。
          const parsed = parseCliResultJson(String(stdout ?? ''));
          if (!isStructuredCliSuccess(parsed)) {
            const reason = error?.killed
              ? `CLI 超时（${JUDGE_TIMEOUT_MS}ms）`
              : error?.message ?? 'CLI 没有给出结构化结果';
            reject(new Error(`${model}: ${reason}`));
            return;
          }
          resolve({
            agentId,
            text: String(parsed.result),
            receivedAt: Date.now(),
            stage: task.stage,
            attribution: { requestId: '24q-regression', note: 'qoder cli' },
            usage: cliUsage(parsed),
            providerId,
            modelId: model,
            latencyMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null
          });
        }
      );
    });
  }

  /** qoder 的 usage 有时全是 0；照抄不猜，读不到就写 null。 */
  function cliUsage(parsed) {
    const usage = parsed?.usage;
    if (!usage || typeof usage !== 'object') return undefined;
    const inputTokens = Number(usage.input_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? 0);
    if (!inputTokens && !outputTokens) return undefined;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }

  /**
   * 所有模型调用都从这里走：辩论、裁判、完整度复核、标准答案评分。
   * 重试只在同一个 agent/model 上做，绝不换模型；每次重试记进 `retryEvents`。
   */
  const askModel = async (agentId, task, questionId = 'unknown') => {
    const model = byId.get(agentId);
    if (!model) throw new Error(`没有模型映射：${agentId}`);
    if (BACKEND === 'cli') {
      const answer = await askQoderCli(agentId, model, task);
      return { ...answer, attempts: 1, retryPolicyVersion: RETRY_POLICY_VERSION };
    }
    const { value: response, attempts } = await withRetryPolicy({
      run: () => provider.generate({
        modelId: model,
        question: task.question,
        ...(task.system ? { system: task.system } : {}),
        ...(task.context ? { context: task.context } : {}),
        timeoutMs: JUDGE_TIMEOUT_MS,
        ...(temperatureEnabled ? { temperature: TEMPERATURE } : {}),
        ...(seedAccepted ? { seed: SEED_VALUE } : {})
      }),
      onAttempt: info => {
        retryEvents.push({
          at: new Date().toISOString(),
          questionId,
          agentId,
          modelId: model,
          policyVersion: RETRY_POLICY_VERSION,
          ...info
        });
        console.log(`[retry] ${questionId} · ${model} · ${info.policyClass} · 等待 ${info.delayMs}ms`);
      }
    });
    return {
      agentId,
      text: response.text,
      receivedAt: Date.now(),
      stage: task.stage,
      attribution: { requestId: '24q-regression', note: 'configured model' },
      usage: response.usage,
      providerId,
      modelId: model,
      latencyMs: response.latencyMs,
      attempts,
      retryPolicyVersion: RETRY_POLICY_VERSION
    };
  };

  async function runQuestion(entry, position, workerId) {
    const { item, datasetIndex } = entry;
    const judgeAgentId = IDS[datasetIndex % IDS.length];
    const debaters = IDS.filter(id => id !== judgeAgentId);
    const startedAt = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tf-regression-${item.id}-`));
    const store = new DebateStore(dir);
    const orchestrator = new DebateOrchestrator(store, { ask: (agentId, task) => askModel(agentId, task, item.id) });
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
    let completeness = null;
    let revision = null;
    let revisionJudge = null;
    let standardAnswerSource = 'original';

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

      // 与产品同一条链：选裁判（本题轮换到的人优先）、失败换人、附带质量
      // 报告与最终决策。以前脚本自己 new JudgeEngine 并直接指定裁判，产品
      // 路径坏了回归照样绿。
      verdict = await adjudicateDebate(state, {
        candidates: async () => judgeCandidates,
        preferredJudgeId: judgeAgentId,
        ask: async (agentId, task) => {
          const answer = await askModel(agentId, task, item.id);
          judgeUsage = answer.usage ?? null;
          judgeLatencyMs = answer.latencyMs ?? null;
          return answer;
        }
      });
      quality = verdict.quality ?? null;
      decision = verdict.finalDecision ?? null;
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
    let standardAnswerText = decision?.conclusion ?? combinedText;
    if (completenessEnabled) {
      const reviewerAgentId = IDS.find(id => id !== judgeAgentId) ?? judgeAgentId;
      completeness = await reviewCompleteness({
        question: item.question,
        answer: standardAnswerText,
        ask: (agentId, task) => askModel(agentId, task, item.id),
        agentId: reviewerAgentId
      });
      if (completeness.backend === 'model' && completeness.hasGap && completeness.missing.length > 0) {
        const reviserAgentId = IDS.find(id => id !== judgeAgentId && id !== reviewerAgentId) ?? reviewerAgentId;
        revision = await reviseAnswer({
          question: item.question,
          answer: standardAnswerText,
          missing: completeness.missing,
          ask: (agentId, task) => askModel(agentId, task, item.id),
          agentId: reviserAgentId
        });
        if (revision.backend === 'model' && revision.revisedAnswer) {
          standardAnswerText = revision.revisedAnswer;
          standardAnswerSource = 'revised';
          // 修订不能自己宣布通过：把修订后的答案再交给独立 Judge 一次。
          if (state) {
            const revisedState = {
              ...state,
              debateId: `${state.debateId}-revised`,
              rounds: [{
                index: 0,
                messages: [{
                  messageId: `${state.debateId}-revised-message`,
                  roundIndex: 0,
                  agentId: 'revision',
                  role: 'peer',
                  kind: 'position',
                  text: revision.revisedAnswer,
                  createdAt: Date.now()
                }],
                startedAt: Date.now(),
                endedAt: Date.now(),
                failures: []
              }],
              minorities: [],
              disputes: [],
              revisions: [],
              evidence: [],
              judgments: [],
              verdict: undefined,
              status: 'completed',
              outcome: 'COMPLETED'
            };
            try {
              const revisedVerdict = await adjudicateDebate(revisedState, {
                candidates: async () => judgeCandidates,
                preferredJudgeId: judgeAgentId,
                ask: (agentId, task) => askModel(agentId, task, item.id)
              });
              revisionJudge = {
                backend: revisedVerdict.backend,
                judgeAgentId: revisedVerdict.judgeAgentId,
                undetermined: revisedVerdict.undetermined,
                conclusion: revisedVerdict.conclusion,
                confidence: revisedVerdict.confidence.level,
                fallbackReason: revisedVerdict.fallbackReason ?? null
              };
            } catch (revisedError) {
              revisionJudge = {
                backend: 'unavailable',
                judgeAgentId,
                undetermined: true,
                conclusion: null,
                confidence: 'low',
                fallbackReason: revisedError instanceof Error ? revisedError.message : String(revisedError)
              };
            }
          }
        }
      }
    }
    if (standardItem) {
      rubricAgentId = IDS.find(id => id !== judgeAgentId) ?? judgeAgentId;
      standardAssessment = await assessStandardAnswer({
        item: standardItem,
        answerText: standardAnswerText,
        ask: (agentId, task) => askModel(agentId, task, item.id),
        agentId: rubricAgentId
      });
    }

    const claimResults = standardItem && standardAssessment
      ? standardItem.requiredClaims.map(claim => {
          const id = claim.id.toLowerCase();
          const matched = standardAssessment.matchedClaims.map(value => value.toLowerCase()).includes(id);
          const explicitlyMissing = standardAssessment.missingClaims
            .map(value => value.toLowerCase())
            .includes(id);
          return {
            id: claim.id,
            severity: claim.severity,
            text: claim.text,
            status: matched && !explicitlyMissing
              ? 'matched'
              : explicitlyMissing || claim.severity === 'must'
                ? 'missing'
                : 'unassessed'
          };
        })
      : null;

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
        // 换过裁判才有；`exhausted` 为 true 表示候选全试过、退回规则版。
        reselection: verdict?.judgeReselection ?? null,
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
        })),
        // 逐轮保留可追溯的答案摘录；完整原文不进报告（体积），但缺了这几百字
        // 就没法解释「rubric 为什么判它缺 c3」。长度单独记录，避免把截断当全文。
        messageExcerpts: messages.map(message => ({
          agentId: message.agentId,
          modelId: message.modelId,
          roundIndex: message.roundIndex,
          chars: message.text.length,
          excerpt: message.text.slice(0, 800)
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
      completeness,
      revision,
      revisionJudge,
      standardAnswerSource,
      answerChars: standardAnswerText.length,
      answerExcerpt: standardAnswerText.slice(0, 4000),
      standard: standardAssessment && standardItem
        ? {
            id: standardItem.id,
            classification: standardItem.classification,
            ...standardAssessment,
            claimResults,
            rubricAgentId,
            participatedInDebate: Boolean(state?.plan?.participants?.includes(rubricAgentId))
          }
        : null,
      anchor: anchorHit(combinedText, item.anchor),
      retryCount: retryEvents.slice(currentRunRetryStart).filter(event => event.questionId === item.id).length,
      retries: retryEvents.slice(currentRunRetryStart).filter(event => event.questionId === item.id),
      error
    };
    console.log(`[w${workerId}] [${position + 1}/${questions.length}] -> ${result.debate.outcome} · judge=${verdict?.backend ?? 'missing'} · quality=${quality?.status ?? 'missing'} · V1=${standardAssessment?.passed ? 'pass' : standardAssessment ? 'fail' : '-'} · ${result.debate.durationSec}s`);
    return result;
  }

  if (RUNS > 1 && incrementalPath) {
    throw new Error('--runs>1 时不能用 --incremental：多次运行必须各自完整重跑');
  }
  if (RUNS > 1 && mergeInto) throw new Error('--runs>1 时不支持 --merge-into');

  const baseline = RUNS === 1 && incrementalPath && fs.existsSync(incrementalPath)
    ? JSON.parse(fs.readFileSync(incrementalPath, 'utf8'))
    : null;
  const baselineById = new Map((baseline?.results ?? []).map(item => [item.id, item]));

  const startedAtAll = new Date().toISOString();
  const repoRoot = path.join(__dirname, '../../..');
  const relativeToRepo = file => path.relative(repoRoot, file).split(path.sep).join('/');
  const config = {
    createdAt: startedAtAll,
    baselineTag: BASELINE_TAG,
    runner: {
      version: RUNNER_VERSION,
      promptVersion: 'none',
      commit: codeSha(),
      adjudication: 'main/judge/adjudicate.adjudicateDebate',
      rulesAuthority: 'debate.claim-judgments',
      backend: providerId,
      provider: BACKEND === 'cli' ? 'qoder-cli' : 'opencode-go',
      baseUrl: BACKEND === 'cli' ? null : BASE,
      node: process.versions.node,
      platform: process.platform,
      economy: ECONOMY
    },
    dataset: {
      version: dataset.version,
      sha256: dataset.sha256,
      note: dataset.note,
      file: relativeToRepo(DATASET_PATH)
    },
    standard: {
      version: standard.version,
      sha256: standardHash,
      file: relativeToRepo(STANDARD_PATH)
    },
    models: MODELS.map(item => ({ id: item.id, model: item.model, provider: providerId })),
    judgeRotation: IDS,
    sampling: samplingSnapshot,
    retryPolicy: retryPolicySnapshot(),
    runtime: {
      runs: RUNS,
      workers,
      providerConcurrency,
      stageTimeoutMs: STAGE_TIMEOUT_MS,
      totalMs: TOTAL_MS,
      waitMs: WAIT_MS,
      judgeTimeoutMs: JUDGE_TIMEOUT_MS,
      completeness: completenessEnabled,
      economy: ECONOMY
    }
  };

  /** 跑完一轮 24 题；`RUNS=1` 时仍保留增量与 latest 行为。 */
  async function executeRun(runIndex) {
    currentRunRetryStart = retryEvents.length;
    const runStartedAt = new Date().toISOString();
    const slots = new Array(questions.length).fill(null);
    const pending = [];
    questions.forEach((entry, position) => {
      if (baseline) {
        const standardItem = standardById.get(entry.item.id);
        const currentFingerprint = fingerprint(entry.item, standardItem);
        const old = baselineById.get(entry.item.id);
        // 旧结果没有 fingerprint 一律重跑；不能拿当前配置反算一个“旧指纹”。
        if (canReuseResult(old, currentFingerprint)) {
          slots[position] = { ...old, reused: true };
          return;
        }
      }
      pending.push({ entry, position });
    });
    console.log(`RUN ${runIndex + 1}/${RUNS}：重跑 ${pending.length} 题${baseline ? `（增量复用 ${questions.length - pending.length} 题）` : ''}`);

    const writeLatest = () => {
      if (RUNS > 1) return;
      const current = slots.filter(Boolean);
      const summary = buildSummary(current);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const partial = {
        dataset: { version: dataset.version, sha256: dataset.sha256, note: dataset.note },
        models: MODELS.map(model => model.model),
        judgeRotation: IDS,
        runner: config.runner,
        sampling: config.sampling,
        retryPolicy: config.retryPolicy,
        createdAt: new Date().toISOString(),
        workers,
        completeness: completenessEnabled,
        incremental: baseline ? {
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
    if (RUNS === 1 && slots.some(Boolean)) writeLatest();

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
    return {
      runId: `run-${runIndex + 1}`,
      startedAt: runStartedAt,
      endedAt: new Date().toISOString(),
      summary: buildSummary(results),
      results,
      retryEvents: retryEvents.slice(currentRunRetryStart)
    };
  }

  const stamp = startedAtAll.replace(/[:.]/g, '-');
  const runs = [];
  const runFiles = [];
  let stoppedEarly = null;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (let runIndex = 0; runIndex < RUNS; runIndex += 1) {
    const run = await executeRun(runIndex);
    runs.push(run);
    const runFile = path.join(OUT_DIR, `debate-regression${suffix}-p0-run${runIndex + 1}-${stamp}.json`);
    const runPayload = {
      kind: 'debate-regression-run',
      config,
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      summary: run.summary,
      retryEvents: run.retryEvents,
      results: run.results
    };
    fs.writeFileSync(runFile, JSON.stringify(runPayload, null, 2), 'utf8');
    fs.writeFileSync(runFile.replace(/\.json$/, '.md'), markdown(run.summary, dataset, run.results), 'utf8');
    runFiles.push(runFile);
    console.log(`RUN ${runIndex + 1} DONE ${JSON.stringify(run.summary)}`);

    // 周额度用尽时，再跑下一轮只会得到整轮 429。宁可把样本停在完整的一轮，
    // 也不要把「额度不足」混成「模型失败」；报告里明确写 stoppedEarly。
    if (RUNS > 1 && runIndex < RUNS - 1) {
      const quotaFailures = run.results.filter(item => {
        const text = JSON.stringify(item.debate?.failures ?? '') + String(item.error ?? '');
        return /429|usage limit|rate.?limit/i.test(text);
      }).length;
      if (quotaFailures >= 4) {
        stoppedEarly = {
          reason: 'quota-or-rate-limit',
          afterRun: run.runId,
          quotaFailures,
          requestedRuns: RUNS,
          completedRuns: runs.length
        };
        console.log(`STOP：${run.runId} 有 ${quotaFailures} 题因 429/额度失败，保留已完成轮次`);
        break;
      }
    }
  }

  if (RUNS === 1) {
    const run = runs[0];
    const createdAt = run.endedAt;
    const runPayload = {
      dataset: { version: dataset.version, sha256: dataset.sha256, note: dataset.note },
      models: MODELS.map(item => item.model),
      judgeRotation: IDS,
      runner: config.runner,
      standard: config.standard,
      sampling: config.sampling,
      retryPolicy: config.retryPolicy,
      createdAt,
      workers,
      completeness: completenessEnabled,
      incremental: baseline ? {
        baseline: incrementalPath,
        reused: run.results.filter(item => item.reused).length,
        pending: run.results.filter(item => !item.reused).length
      } : null,
      summary: run.summary,
      results: run.results
    };
    const latest = path.join(OUT_DIR, `debate-regression${suffix}-latest.json`);
    fs.writeFileSync(latest, JSON.stringify(runPayload, null, 2), 'utf8');
    const runStamp = createdAt.replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-${runStamp}.json`), JSON.stringify(runPayload, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, `debate-regression${suffix}-latest.md`), markdown(run.summary, dataset, run.results), 'utf8');
    if (mergeInto) {
      const existing = JSON.parse(fs.readFileSync(mergeInto, 'utf8'));
      const existingById = new Map((existing.results ?? []).map(item => [item.id, item]));
      for (const item of run.results) existingById.set(item.id, item);
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
  } else {
    const stats = buildBaselineStats(runs, dataset.questions);
    config.stoppedEarly = stoppedEarly;
    const baselinePayload = {
      kind: 'debate-p0-baseline',
      config,
      requestedRuns: RUNS,
      sampleCount: runs.length,
      stoppedEarly,
      stats,
      runs: runs.map((run, index) => ({
        runId: run.runId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        summary: run.summary,
        retryEvents: run.retryEvents,
        reportFile: relativeToRepo(runFiles[index]),
        results: run.results
      }))
    };
    const baselinePath = path.join(OUT_DIR, `debate-regression${suffix}-p0-baseline-${stamp}.json`);
    const baselineMarkdown = markdownBaseline({ stats, config, runs });
    fs.writeFileSync(baselinePath, JSON.stringify(baselinePayload, null, 2), 'utf8');
    fs.writeFileSync(baselinePath.replace(/\.json$/, '.md'), baselineMarkdown, 'utf8');
    fs.writeFileSync(
      path.join(OUT_DIR, `debate-regression${suffix}-p0-baseline-latest.json`),
      JSON.stringify(baselinePayload, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(OUT_DIR, `debate-regression${suffix}-p0-baseline-latest.md`),
      baselineMarkdown,
      'utf8'
    );
    const hashLines = [baselinePath, DATASET_PATH, STANDARD_PATH, ...runFiles]
      .map(file => `${sha256File(file)}  ${relativeToRepo(file)}`);
    fs.writeFileSync(baselinePath.replace(/\.json$/, '.sha256'), `${hashLines.join('\n')}\n`, 'utf8');
    console.log(`BASELINE ${baselinePath}`);
    console.log(`BASELINE STATS ${JSON.stringify(stats.aggregate)}`);
  }

  const allStructural = runs.every(run => run.summary.structuralOk);
  console.log(`DONE ${JSON.stringify(RUNS === 1 ? runs[0].summary : {
    sampleCount: RUNS,
    runs: runs.map(run => run.summary)
  })}`);
  app.exit(allStructural ? 0 : 2);
}).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

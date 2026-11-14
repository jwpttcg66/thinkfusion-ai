/**
 * V3.0 P1/P2 真实运行：用户配置的三个模型，两位辩论，第三位独立裁判。
 *
 * 运行前先 npm run build:test。
 * 只使用 execution-defaults 里勾选的 deepseek / gpt / kimi；
 * 裁判不参加辩论，避免 sharedWith。
 */
const { app, safeStorage } = require('electron');
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
const DEBATERS = ['deepseek', 'gpt'];
const JUDGE = 'kimi';
const QUESTION = '团队准备把本地代码索引从“每次覆盖旧索引”改成“Generation 原子快照”。请分析收益、风险和适用条件。';

app.setName('ThinkFusion');
app.whenReady().then(async () => {
  const key = safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'thinkfusion-ai', 'api-keys.json'), 'utf8'))['opencode-go'].cipher, 'base64'));
  const provider = new OpenAICompatibleProvider({
    id: 'opencode-go', label: 'OpenCode Go', baseUrl: BASE,
    models: MODELS.map(item => item.model), defaultModel: MODELS[0].model,
    keyStore: { has: () => true, get: () => key },
    maxConcurrency: 3, maxRetries: 1, timeoutMs: 300_000,
    extraHeaders: { 'user-agent': 'thinkfusion-debate-p1', 'x-opencode-session': 'quality-run' }
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
      timeoutMs: 300_000
    });
    return {
      agentId,
      text: response.text,
      receivedAt: Date.now(),
      stage: task.stage,
      attribution: { requestId: 'quality-run', note: 'configured model' },
      usage: response.usage,
      providerId: 'opencode-go',
      modelId: model,
      latencyMs: response.latencyMs
    };
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-debate-quality-'));
  const store = new DebateStore(dir);
  const plan = planLead({ mode: 'cloud', strategy: 'truth', candidates, selected: DEBATERS });
  const orchestrator = new DebateOrchestrator(store, { ask: askModel });
  const started = orchestrator.start(QUESTION, {
    strategy: 'truth',
    maxRounds: 2,
    participants: DEBATERS,
    convergenceStop: false,
    leadMode: 'cloud',
    budget: { stageTimeoutMs: 300_000, maxConcurrency: 2 }
  }, undefined, plan);
  const state = await orchestrator.waitFor(started.debateId, 420_000);
  if (!state) throw new Error('辩论没有在时限内结束');

  const judgeCalls = [];
  const engine = new JudgeEngine({
    judgeAgentId: JUDGE,
    sharedWith: state.plan.participants.includes(JUDGE) ? JUDGE : undefined,
    ask: async (agentId, task) => {
      const answer = await askModel(agentId, task);
      judgeCalls.push({
        agentId,
        modelId: answer.modelId,
        latencyMs: answer.latencyMs,
        usage: answer.usage,
        outputChars: answer.text.length
      });
      return answer;
    }
  });
  const verdict = await engine.judge(state);
  const quality = evaluateDebateQuality({
    state,
    verdict,
    modelAssessed: verdict.backend === 'model'
  });
  const decision = finalizeDebate(state, verdict, quality);

  console.log(JSON.stringify({
    models: MODELS.map(item => item.model),
    debaters: DEBATERS,
    judge: JUDGE,
    debate: {
      status: state.status,
      outcome: state.outcome,
      rounds: state.rounds.length,
      messages: state.rounds.flatMap(round => round.messages).length,
      failures: state.rounds.flatMap(round => round.failures),
      messageUsage: state.rounds.flatMap(round => round.messages).map(message => ({
        agentId: message.agentId,
        modelId: message.modelId,
        inputTokens: message.usage?.inputTokens ?? null,
        outputTokens: message.usage?.outputTokens ?? null
      }))
    },
    judge: {
      backend: verdict.backend,
      judgeAgentId: verdict.judgeAgentId,
      sharedWith: verdict.sharedWith ?? null,
      undetermined: verdict.undetermined,
      confidence: verdict.confidence,
      fallbackReason: verdict.fallbackReason ?? null,
      calls: judgeCalls
    },
    quality: {
      status: quality.status,
      modelAssessed: quality.modelAssessed,
      factualAccuracy: quality.dimensions.factualAccuracy,
      logicalValidity: quality.dimensions.logicalValidity,
      evidenceQuality: quality.dimensions.evidenceQuality,
      uncertaintyCalibration: quality.dimensions.uncertaintyCalibration,
      conclusionConsistency: quality.dimensions.conclusionConsistency,
      criticalIssues: quality.criticalIssues,
      explanation: quality.explanation,
      rule: { passed: quality.rule.passed, total: quality.rule.total, ok: quality.rule.ok }
    },
    decision
  }, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

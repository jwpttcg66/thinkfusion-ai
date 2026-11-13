/**
 * P0 spike：六种辩论策略各跑一场真实云端双模型辩论。
 *
 * 只用于验证「策略真的能跑」，不负责人工质量评分。
 * 运行：
 *   npm run build:test
 *   ./node_modules/.bin/electron scripts/spikes/debate-cloud-strategies.cjs --no-sandbox
 */

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DebateStore } = require('../../out-test/main/debate/store.js');
const { DebateOrchestrator } = require('../../out-test/main/debate/orchestrator.js');
const { planLead } = require('../../out-test/main/debate/lead.js');
const { OpenAICompatibleProvider } = require('../../out-test/main/providers/openai-compatible.js');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODELS = [
  { id: 'deepseek', model: 'deepseek-v4.1-flash' },
  { id: 'claude', model: 'claude-haiku-5-5' }
];
const STRATEGIES = ['truth', 'adversarial', 'expert', 'assumption', 'solution', 'discovery'];
const QUESTION = '团队准备把本地代码索引从“每次覆盖旧索引”改成“Generation 原子快照”。请分析这个决定的关键收益、风险和适用条件。';

app.setName('ThinkFusion');
app.whenReady().then(async () => {
  const keyFile = path.join(app.getPath('appData'), 'thinkfusion-ai', 'api-keys.json');
  const key = safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))['opencode-go'].cipher, 'base64'));
  const provider = new OpenAICompatibleProvider({
    id: 'opencode-go', label: 'OpenCode Go', baseUrl: BASE,
    models: MODELS.map(item => item.model), defaultModel: MODELS[0].model,
    keyStore: { has: () => true, get: () => key },
    maxConcurrency: 2, maxRetries: 1, timeoutMs: 90_000,
    extraHeaders: { 'user-agent': 'thinkfusion-debate-p0', 'x-opencode-session': 'debate-strategies' }
  });
  const byId = new Map(MODELS.map(item => [item.id, item.model]));
  const candidates = MODELS.map(item => ({ id: item.id, label: item.model, type: 'cloud', available: true }));
  const results = [];

  for (const strategy of STRATEGIES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tf-debate-${strategy}-`));
    const store = new DebateStore(dir);
    const plan = planLead({ mode: 'cloud', strategy, candidates });
    const startedAt = Date.now();
    const orchestrator = new DebateOrchestrator(store, {
      ask: async (agentId, task) => {
        const model = byId.get(agentId);
        if (!model) throw new Error(`没有模型映射：${agentId}`);
        const response = await provider.generate({
          modelId: model,
          question: task.question,
          ...(task.system ? { system: task.system } : {}),
          ...(task.context ? { context: task.context } : {}),
          timeoutMs: 90_000
        });
        return {
          agentId, text: response.text, receivedAt: Date.now(), stage: task.stage,
          attribution: { requestId: 'debate-p0', note: 'real cloud model' },
          usage: response.usage, latencyMs: response.latencyMs
        };
      }
    });
    const state = orchestrator.start(QUESTION, {
      strategy, maxRounds: 2, participants: MODELS.map(item => item.id),
      convergenceStop: false, leadMode: 'cloud',
      budget: { stageTimeoutMs: 120_000, maxConcurrency: 2 }
    }, undefined, plan);
    const finished = await orchestrator.waitFor(state.debateId, 240_000);
    results.push({
      strategy,
      status: finished?.status,
      rounds: finished?.rounds.length,
      messages: finished?.rounds.flatMap(round => round.messages).length,
      roles: [...new Set(finished?.rounds.flatMap(round => round.messages.map(message => message.role)) ?? [])],
      failures: finished?.rounds.flatMap(round => round.failures),
      revisions: finished?.revisions?.length ?? 0,
      durationMs: Date.now() - startedAt
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ models: MODELS.map(item => item.model), results }, null, 2));
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

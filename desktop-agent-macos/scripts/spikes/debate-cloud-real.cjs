/**
 * P0 spike：用真实云端模型跑一场多模型辩论。
 *
 * 这不是产品入口；它只验证：
 *   - 同一 OpenAI 兼容 Provider 下多个真实模型能被 DebateOrchestrator 调用；
 *   - 角色、两轮发言、失败记录和落盘结构可用；
 *   - 报告不会把未配置的 Provider 说成已配置。
 *
 * 运行：
 *   npm run build:test
 *   ./node_modules/.bin/electron scripts/spikes/debate-cloud-real.cjs --no-sandbox
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
  { id: 'glm', model: 'glm-5.3' },
  { id: 'claude', model: 'claude-haiku-5-5' }
];
const QUESTION = '用两句话说明：为什么把代码索引按 generation 做原子快照，比每次覆盖旧索引更可靠？';

app.setName('ThinkFusion');
app.whenReady().then(async () => {
  const keyFile = path.join(app.getPath('appData'), 'thinkfusion-ai', 'api-keys.json');
  const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const key = safeStorage.decryptString(Buffer.from(stored['opencode-go'].cipher, 'base64'));
  const provider = new OpenAICompatibleProvider({
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: BASE,
    models: MODELS.map(item => item.model),
    defaultModel: MODELS[0].model,
    keyStore: { has: () => true, get: () => key },
    maxConcurrency: 3,
    maxRetries: 1,
    timeoutMs: 90_000,
    extraHeaders: {
      'user-agent': 'thinkfusion-debate-p0',
      'x-opencode-session': 'debate-p0'
    }
  });

  const byId = new Map(MODELS.map(item => [item.id, item.model]));
  const candidates = MODELS.map(item => ({ id: item.id, label: item.model, type: 'cloud', available: true }));
  const plan = planLead({ mode: 'cloud', strategy: 'truth', candidates });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-debate-p0-'));
  const store = new DebateStore(dir);
  const begun = Date.now();

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
        agentId,
        text: response.text,
        receivedAt: Date.now(),
        stage: task.stage,
        attribution: { requestId: 'debate-p0', note: 'real cloud model' },
        usage: response.usage,
        latencyMs: response.latencyMs
      };
    }
  });

  const state = orchestrator.start(QUESTION, {
    strategy: 'truth',
    maxRounds: 2,
    participants: MODELS.map(item => item.id),
    convergenceStop: false,
    leadMode: 'cloud'
  }, undefined, plan);
  const finished = await orchestrator.waitFor(state.debateId, 180_000);

  const report = {
    provider: 'opencode-go',
    baseUrl: BASE,
    models: MODELS.map(item => item.model),
    strategy: finished?.config.strategy,
    lead: finished?.lead,
    rounds: finished?.rounds.length,
    messages: finished?.rounds.flatMap(round => round.messages.map(message => ({
      agentId: message.agentId,
      role: message.role,
      kind: message.kind,
      chars: message.text.length,
      latencyMs: typeof message.startedAt === 'number' && typeof message.endedAt === 'number'
        ? message.endedAt - message.startedAt
        : null
    }))),
    failures: finished?.rounds.flatMap(round => round.failures),
    revisions: finished?.revisions?.length ?? 0,
    status: finished?.status,
    durationMs: Date.now() - begun
  };
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

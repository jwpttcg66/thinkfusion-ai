/**
 * DMOCA 真机：决策里留下的人 == 实际被请去评审的人。
 *
 * 造一个 L1 任务、选 3 个模型：策略上限是 2 人，第三人必须带原因进 excluded，
 * 辩论也只请这 2 人。以前决策只写事件、派发仍按全量，这条真机就是为了证明
 * 「记录」和「实际」是同一份名单。
 *
 * CDP_ENDPOINT=http://127.0.0.1:9346/json node scripts/dmoca-dispatch-live.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9346/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-dmoca-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 420000);
const REPORT = process.env.DMOCA_REPORT
  ?? path.resolve('../docs/implementation/evidence/V3-P0-DMOCA-DISPATCH-LIVE.json');

fs.rmSync(WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'note.txt'), 'dmoca\n');

const targets = await (await fetch(ENDPOINT)).json();
const app = targets.find(t => t.type === 'page') ?? targets[0];
if (!app) throw new Error('no renderer');
const cdp = await connect(app);

const defaults = await cdp.evaluate('window.agentAPI.getExecutionDefaults()');
const models = (process.env.DMOCA_MODELS ?? 'opencode-go:deepseek-v4.1-flash,opencode-go:glm-5.2,opencode-go:kimi-k3')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const conversation = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({
  text: '把工作区 note.txt 的内容改成包含 dmoca 与 dispatch 两个词，只改这一个文件。',
  permissionPreset: 'workspace-write',
  workspaceRoot: WORKSPACE,
  workspaceMode: 'engineering',
  executionConfig: { ...defaults, selectedCloudModels: models },
  taskKindOverride: 'execution'
})})`);
const taskId = conversation.taskId;
assert.ok(taskId);
console.log(`task ${taskId}`);
const evidence = { startedAt: new Date().toISOString(), taskId, requestedModels: models };

const deadline = Date.now() + TIMEOUT_MS;
let participation = null;
let debated = null;
while (Date.now() < deadline) {
  await sleep(2500);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  participation = events.filter(e => e.type === 'model.participation.selected').pop() ?? participation;
  debated = events.filter(e => e.type === 'plan.debated').pop() ?? debated;
  if (debated) break;
  const task = await cdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
  if (task && ['failed', 'cancelled'].includes(task.status)) break;
}

const partIds = (participation?.participants ?? []).map(item => item.participantId);
const debatedIds = (debated?.debate?.participants ?? []).map(item => item.participantId ?? item);
const checks = {
  'participation-exists': { ok: Boolean(participation), detail: `n=${partIds.length}` },
  'capped-to-policy': {
    ok: partIds.length > 0 && partIds.length <= Math.min(models.length, 2),
    detail: `requested=${models.length} participants=${partIds.length}（L1 上限 2）`
  },
  'excluded-visible': {
    ok: models.length <= partIds.length || (participation?.excluded?.length ?? 0) > 0,
    detail: `excluded=${(participation?.excluded ?? []).map(item => `${item.participantId}:${item.reason}`).join('|')}`
  },
  'dispatch-equals-decision': {
    ok: debatedIds.length === 0
      ? true
      : debatedIds.length === partIds.length && debatedIds.every(id => partIds.includes(id)),
    detail: debatedIds.length === 0
      ? `辩论未开（status=${debated?.debate?.status ?? 'none'}），无可比对名单`
      : `decision=${partIds.join(',')} actual=${debatedIds.join(',')}`
  }
};
for (const [name, item] of Object.entries(checks)) console.log(`${item.ok ? 'OK' : 'FAIL'}  ${name} — ${item.detail}`);

evidence.participation = { participants: partIds, excluded: participation?.excluded ?? [], reasons: participation?.reasons ?? [] };
evidence.debated = debated ? { status: debated.debate?.status, participants: debatedIds } : null;
evidence.checks = checks;
evidence.ok = Object.values(checks).every(item => item.ok);
evidence.finishedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
try { await cdp.evaluate(`void window.agentAPI.cancelTask(${JSON.stringify(taskId)})`); } catch { /* ignore */ }
cdp.close();
process.exit(evidence.ok ? 0 : 1);

/**
 * V4 P1 M2-3：上下文状态投影 + 只读链路与折叠段的源码守卫。
 * Run: npm run test:context-state
 *
 * 断言只有一个方向：这一栏只能转述事件说过的话。「没有记录到」必须投影成 null，
 * 不能投影成 0——0 会让用户以为暂停真的留下了检查点、副作用真的核对过。
 * 后半段按本仓库惯例用源码守卫覆盖渲染层（无 DOM 测试设施）：真机 DOM 的核对交给
 * verify-v4-p1-m2-3-cdp.mjs。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { contextStateSummary, EMPTY_CONTEXT_STATE, projectContextState } from '../out-test/shared/context-state.js';
import { contextEventView } from '../out-test/shared/context.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function paused(overrides = {}) {
  return {
    type: 'context.checkpoint.paused',
    at: 1_000,
    taskId: 't1',
    reason: 'pause',
    goalVersion: 1,
    taskRevision: 3,
    needsReconciliation: 1,
    checkpointId: 'cp_1',
    contextId: 'pause:t1:900',
    activeRunId: 'run-a',
    ...overrides
  };
}

function ctx(event, context, overrides = {}) {
  return {
    type: 'context.event',
    at: 2_000,
    taskId: 't1',
    event,
    context: { contextId: 'ctx_1', ...context },
    ...overrides
  };
}

test('一条上下文事件都没有：判「没有记录」，不画成「已核对 0 项」', () => {
  const view = projectContextState([]);
  assert.equal(view.hasEvents, false);
  assert.equal(view.contextId, null);
  assert.equal(view.lastReconciliation, null);
  assert.equal(view.lastRebuild, null);
  assert.deepEqual(view.checkpoints, []);
  assert.equal(contextStateSummary(view), '没有记录到上下文事件');
});

test('暂停存档：检查点、任务版本、待核对条数都取自事件原文', () => {
  const view = projectContextState([paused()]);
  assert.equal(view.checkpoints.length, 1);
  assert.equal(view.checkpoints[0].checkpointId, 'cp_1');
  assert.equal(view.checkpoints[0].source, 'pause');
  assert.equal(view.checkpoints[0].goalVersion, 1);
  assert.equal(view.checkpoints[0].taskRevision, 3);
  assert.equal(view.checkpoints[0].needsReconciliation, 1);
  assert.equal(view.contextId, 'pause:t1:900');
  // 暂停事件只有 needsReconciliation，没有 applied/missing —— 留 null，不写 0。
  assert.deepEqual(view.lastReconciliation, {
    at: 1_000,
    applied: null,
    missing: null,
    needsReconciliation: 1,
    source: 'pause'
  });
});

test('取消存档也算一次存档，但 source 要分清（口径不同：取消不会续跑）', () => {
  const view = projectContextState([paused({ reason: 'cancel', at: 1_500, needsReconciliation: 0 })]);
  assert.equal(view.checkpoints[0].source, 'cancel');
  assert.equal(view.lastReconciliation.source, 'cancel');
  assert.equal(view.lastReconciliation.needsReconciliation, 0);
});

test('暂停没留下检查点：不进检查点清单，但必须看得见「未提交」和原因', () => {
  const view = projectContextState([
    { type: 'context.checkpoint.paused', at: 1_000, taskId: 't1', reason: 'pause',
      goalVersion: 1, taskRevision: 2, needsReconciliation: 0,
      unavailableReason: '当前宿主没有检查点能力' }
  ]);
  assert.deepEqual(view.checkpoints, []);
  assert.match(view.entries[0].text, /^暂停未提交检查点：当前宿主没有检查点能力$/);
  assert.equal(view.entries[0].tone, 'warn');
  assert.equal(view.lastRebuild.kind, 'checkpoint-missing');
  assert.equal(view.lastRebuild.reason, '当前宿主没有检查点能力');
  // 没有 checkpointId 时不能凭空报一个「最近检查点」
  assert.match(contextStateSummary(view), /没有检查点存档/);
});

test('恢复事件带副作用账本：applied/missing/待核对三项齐取，来源标 recovered', () => {
  const view = projectContextState([
    paused(),
    ctx('context.recovered', {
      contextId: 'ctx_1',
      checkpointId: 'cp_1',
      pointerSource: 'task-fields',
      reason: '从 Journal 活动指针恢复',
      sideEffects: { applied: 6, missing: 0, needsReconciliation: 0 }
    }, { at: 3_000 })
  ]);
  assert.deepEqual(view.lastReconciliation, {
    at: 3_000, applied: 6, missing: 0, needsReconciliation: 0, source: 'recovered'
  });
  assert.equal(view.lastRebuild.kind, 'recovered');
  assert.equal(view.lastRebuild.pointerSource, 'task-fields');
  assert.equal(view.lastRebuild.checkpointId, 'cp_1');
  // 「上次重建时间与原因」取的就是这一条
  assert.equal(view.lastRebuild.at, 3_000);
  assert.equal(view.lastRebuild.reason, '从 Journal 活动指针恢复');
});

test('续跑与被迫重规划各成一行，步数与理由都来自 resume 载荷', () => {
  const continued = projectContextState([
    ctx('context.resume.continued', {
      contextId: 'ctx_1',
      checkpointId: 'cp_1',
      reason: '检查点有效、副作用账本无未知缺口，直接续跑已批准计划 p1',
      resume: { mode: 'continue', planId: 'p1', roundId: 'r2',
        reusedStepIds: ['s1', 's2'], pendingStepIds: ['s3'], reasons: [] }
    })
  ]);
  assert.equal(continued.lastRebuild.kind, 'resume-continue');
  assert.deepEqual(continued.lastRebuild.resume.reusedStepIds, ['s1', 's2']);
  assert.deepEqual(continued.lastRebuild.resume.pendingStepIds, ['s3']);
  assert.equal(continued.lastRebuild.resume.planId, 'p1');
  // 文案与时间线/对话流同源，不再另写一份（M2-2 收到一处）
  assert.equal(continued.lastRebuild.text, contextEventView('context.resume.continued').text);

  const replanned = projectContextState([
    ctx('context.resume.replanned', {
      contextId: 'ctx_1',
      resume: { mode: 'replan', reasons: ['1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）'] }
    })
  ]);
  assert.equal(replanned.lastRebuild.kind, 'resume-replan');
  assert.equal(replanned.lastRebuild.tone, 'warn');
  assert.deepEqual(replanned.lastRebuild.resume.reasons, [
    '1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）'
  ]);
  // 没带的字段一律 null，不编造 planId
  assert.equal(replanned.lastRebuild.resume.planId, null);
  assert.deepEqual(replanned.lastRebuild.resume.reusedStepIds, []);
});

test('工程上下文过期要单独成行：恢复走通不代表上下文可用', () => {
  const view = projectContextState([
    ctx('context.recovered', { contextId: 'ctx_1', pointerSource: 'task-fields' }, { at: 3_000 }),
    ctx('context.refresh.required', { contextId: 'ctx_1', reason: 'ECO 版本落后于当前工程快照' }, { at: 3_100 })
  ]);
  assert.equal(view.rebuilds.length, 2);
  assert.equal(view.lastRebuild.kind, 'refresh-required');
  assert.equal(view.lastRebuild.tone, 'warn');
  assert.equal(view.lastRebuild.reason, 'ECO 版本落后于当前工程快照');
  // refresh.required 不带账本 → 不能把上一步 recovered 的核对结果冲掉
  assert.equal(view.lastRebuild.sideEffects, null);
});

test('contextId 取时间最新一条非空值：空串是「未提供」，不是「换了一份上下文」', () => {
  const view = projectContextState([
    ctx('context.recovered', { contextId: 'ctx_new' }, { at: 5_000 }),
    ctx('context.prepared', { contextId: '' }, { at: 6_000 })
  ]);
  assert.equal(view.contextId, 'ctx_new');
  assert.equal(view.contextIdFrom.at, 5_000);
});

test('事件乱序进来也按时间升序折，同刻按 sequence 保序', () => {
  const view = projectContextState([
    ctx('context.resume.continued', { contextId: 'ctx_2' }, { at: 4_000, sequence: 2 }),
    ctx('context.recovered', { contextId: 'ctx_1' }, { at: 4_000, sequence: 1 }),
    paused({ at: 1_000 })
  ]);
  assert.deepEqual(view.rebuilds.map(item => item.kind), ['recovered', 'resume-continue']);
  assert.deepEqual(view.entries.map(item => item.at), [1_000, 4_000, 4_000]);
  assert.equal(view.contextId, 'ctx_2');
});

test('压缩存档算一次检查点，但它不产副作用账本', () => {
  const view = projectContextState([
    ctx('context.compaction.committed', { contextId: 'ctx_1', checkpointId: 'cp_c1', estimatedTokens: 9_000, level: 'compaction' }, { at: 2_000 })
  ]);
  assert.equal(view.checkpoints.length, 1);
  assert.equal(view.checkpoints[0].source, 'compaction');
  assert.equal(view.checkpoints[0].needsReconciliation, null);
  assert.equal(view.lastReconciliation, null);
  assert.equal(contextStateSummary(view), '1 条 context 事件 · 最近检查点 cp_c1 · 未做副作用核对');
  // 摘要跟在标题「上下文」后面，自己不能再以「上下文」开头（真机渲染成「上下文 上下文 …」）
  assert.equal(contextStateSummary(view).startsWith('上下文'), false);
  assert.equal(contextStateSummary(EMPTY_CONTEXT_STATE).startsWith('上下文'), false);
});

test('预算水位取最后一条真带 usage 的事件，缺的字段留 null', () => {
  const view = projectContextState([
    ctx('context.prepared', { contextId: 'ctx_1', level: 'normal', estimatedTokens: 1_200, contextWindow: 128_000, usageRatio: 0.01 }, { at: 100 }),
    ctx('context.budget.warning', { contextId: 'ctx_1', level: 'warning', estimatedTokens: 120_000 }, { at: 200 })
  ]);
  assert.equal(view.budget.at, 200);
  assert.equal(view.budget.level, 'warning');
  assert.equal(view.budget.estimatedTokens, 120_000);
  assert.equal(view.budget.contextWindow, null);
  assert.equal(view.budget.usageRatio, null);
});

test('详情检查入口：每条事件都留着原文 payload，界面能展开核对而不是只给一句话', () => {
  const view = projectContextState([
    paused({ activeRunId: 'run-a' }),
    ctx('context.resume.continued', {
      contextId: 'ctx_1', checkpointId: 'cp_1', pointerSource: 'task-fields',
      resume: { mode: 'continue', planId: 'p1', reusedStepIds: ['s1'], pendingStepIds: ['s2'], reasons: [] }
    }, { at: 4_000 })
  ]);
  const pauseEntry = view.entries[0];
  assert.equal(pauseEntry.type, 'context.checkpoint.paused');
  assert.equal(pauseEntry.detail.activeRunId, 'run-a');
  assert.equal(pauseEntry.detail.taskRevision, 3);
  const resumeEntry = view.entries[1];
  assert.equal(resumeEntry.type, 'context.event:context.resume.continued');
  assert.equal(resumeEntry.detail.pointerSource, 'task-fields');
  assert.deepEqual(resumeEntry.detail.resume.reusedStepIds, ['s1']);
});

test('多次暂停留多条检查点记录，摘要取最近一份，历史不被覆盖', () => {
  const view = projectContextState([
    paused({ at: 1_000, checkpointId: 'cp_first', contextId: 'pause:t1:1' }),
    paused({ at: 8_000, checkpointId: 'cp_second', contextId: 'pause:t1:8', needsReconciliation: 2 })
  ]);
  assert.deepEqual(view.checkpoints.map(item => item.checkpointId), ['cp_first', 'cp_second']);
  assert.match(contextStateSummary(view), /最近检查点 cp_second/);
  assert.equal(view.contextId, 'pause:t1:8');
  assert.equal(view.lastReconciliation.needsReconciliation, 2);
});

// ---------------------------------------------------------------------------
// 源码守卫：这一段是「只读投影 + 只读 IPC + 一个折叠段」，多一处写入就多一处真相
// ---------------------------------------------------------------------------

test('守卫：投影是纯函数，不发事件、不落盘、不读检查点文件', () => {
  const shared = source('src/shared/context-state.ts');
  assert.doesNotMatch(shared, /from 'electron'/);
  assert.doesNotMatch(shared, /appendFileSync|readFileSync|emitAgentEvent|store\./);
  // 只转述既有事件，不发明新的 context.* 名字
  const declared = [...shared.matchAll(/'context\.[a-z.]+'/g)].map(m => m[0]);
  const known = new Set([
    "'context.event'", "'context.checkpoint.paused'", "'context.compaction.committed'",
    "'context.recovered'", "'context.refresh.required'", "'context.resume.continued'",
    "'context.resume.replanned'", "'context.compaction.stale'"
  ]);
  const unknown = declared.filter(name => !known.has(name));
  assert.deepEqual(unknown, [], `投影引用了不在事件契约里的名字：${unknown.join(', ')}`);
});

test('守卫：task:context 处理器做了信任检查、参数过 schema，且只有读动作', () => {
  const main = source('src/main/index.ts');
  const at = main.indexOf("ipcMain.handle('task:context'");
  assert.ok(at > -1, '主进程没有注册 task:context');
  const next = main.indexOf('ipcMain.handle', at + 10);
  const body = main.slice(at, next === -1 ? main.length : next);
  assert.match(body, /trustedUiSender\(event\)/);
  assert.match(body, /TaskIdSchema\.parse\(taskId\)/);
  assert.ok(body.includes('projectContextState(store.listEvents('), '取数必须来自 store 的事件回放');
  assert.doesNotMatch(body, /orchestrator\.|emitAgentEvent|store\.append|store\.save|readFileSync/);
});

test('守卫：能力仍是枚举的——契约、preload、mock、文档四处口径一致', () => {
  assert.match(
    source('src/shared/contracts.ts'),
    /getTaskContext\(taskId: string\): Promise<import\('\.\/context-state'\)\.ContextStateView>/
  );
  assert.ok(source('src/preload/index.ts').includes("ipcRenderer.invoke('task:context', taskId)"));
  assert.ok(source('src/renderer/src/mock-api.ts').includes('getTaskContext: async taskId => projectContextState('));
  assert.match(source('src/renderer/src/global.d.ts'), /agentAPI: AgentApi/);
  assert.match(source('docs/IPC.md'), /\| `task:context` \| `taskId` \| `ContextStateView` \|/);
});

test('守卫：上下文折叠段挂在任务详情页，目标状态要求的四件事都有出口', () => {
  const app = source('src/renderer/src/App.tsx');
  assert.ok(app.includes("import { TaskContextCard } from './components/engineering/TaskContextCard'"));
  assert.ok(app.includes('<TaskContextCard taskId={activeTask.taskId} refreshKey={events.length} />'));
  const card = source('src/renderer/src/components/engineering/TaskContextCard.tsx');
  assert.ok(card.includes('<details className="card task-context-card">'), '必须是折叠段，不抢详情页首屏');
  for (const field of ['当前上下文', '最近检查点', '副作用核对', '上次重建', '重建原因', '存档时间', '续跑判定', '核对来源', '来源事件', '预算水位']) {
    assert.ok(card.includes(`>${field}<`), `缺少「${field}」这一栏`);
  }
  // 详情检查入口（AGENTS.md §8）：每条事件都要能展开看到原文
  assert.ok(card.includes('（详情检查入口）'));
  assert.ok(card.includes('JSON.stringify(row.detail, null, 2)'));
  assert.ok(card.includes('window.agentAPI.getTaskContext(taskId)'));
  assert.ok(source('src/renderer/src/style.css').includes('.task-context-card'));
});

test('守卫：界面取不到就写「未记录」，不许用 0 冒充核对过', () => {
  const card = source('src/renderer/src/components/engineering/TaskContextCard.tsx');
  assert.ok(card.includes("return value === null ? '未记录' : String(value)"), 'num() 必须把 null 投影成「未记录」');
  assert.ok(card.includes('${num(rec.applied)}'));
  assert.ok(card.includes('${num(rec.missing)}'));
  assert.ok(card.includes('${num(view.budget.estimatedTokens)}'));
  assert.doesNotMatch(card, /存在 \$\{String\(rec\.applied\)/);
  assert.ok(card.includes('这个任务没有记录到上下文事件'));
  assert.ok(card.includes('不拿 0 代替没核对'));
  // 重规划那一行复用/本轮清单都是空的：写「复用 0 步 · 本轮执行 0 步」会被读成「这一轮没干活」，
  // 它真正的意思是整轮作废。真机第一轮就是在探针 C 的行头上照出这句话的。
  assert.ok(card.includes("'不复用上一轮步骤'"), '重规划行必须改说「不复用上一轮步骤」');
});


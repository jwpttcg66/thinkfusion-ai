import { synthesize } from '../../shared/synthesizer';
import {
  NoUsableAgentError,
  describeUnusable,
  type ChannelOutcome,
  type ResearchOutcome,
  type ResearchRequest,
  type ResearchSink
} from '../master-agent';
import type { SubAgentAnswer, SubAgentPool } from '../agents/types';
import {
  planCollaboration,
  type CollaborationPlan,
  type CollaborationStrategy,
  type CollaborationTask
} from './strategy';

/**
 * Phase F 的执行器：按计划分轮、分批地跑，每个子任务留下独立记录。
 *
 * 与 MasterAgent 的关系：默认 `parallel` 仍走 MasterAgent（老路径、零风险），
 * 只有用户显式选了别的策略才用这里。两者都实现 `research()`，
 * `ConversationRunner` 只认这个方法，不认具体类。
 *
 * 失败恢复只做一件克制的事：单个任务失败重试一次，且绝不影响同批其他人。
 * 不把失败成员的活转给别人——那是悄悄改变参与名单，会破坏交叉验证。
 */
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface CollaborationRecord {
  taskId: string;
  agentId: string;
  label: string;
  stage: number;
  status: TaskStatus;
  attempts: number;
  /** 这一轮带上了几条前序回答。 */
  contextCount: number;
  startedAt?: number;
  endedAt?: number;
  latencyMs?: number;
  text?: string;
  error?: string;
}

export interface CollaborationResult {
  outcome: ResearchOutcome;
  records: CollaborationRecord[];
  plan: CollaborationPlan;
}

export interface RunOptions {
  retries?: number;
  now?: () => number;
  onRecord?: (record: CollaborationRecord) => void;
}

export async function runCollaboration(
  pool: SubAgentPool,
  plan: CollaborationPlan,
  sink: ResearchSink,
  options: RunOptions = {}
): Promise<CollaborationResult> {
  const now = options.now ?? Date.now;
  const retries = Math.max(0, options.retries ?? 1);
  const records = new Map<string, CollaborationRecord>();
  const channels: ChannelOutcome[] = [];
  const answers: SubAgentAnswer[] = [];
  const messageIds = new Map<string, string>();
  const completedText: string[] = [];

  for (const task of plan.tasks) {
    records.set(task.taskId, {
      taskId: task.taskId,
      agentId: task.agentId,
      label: task.label,
      stage: task.stage,
      status: 'pending',
      attempts: 0,
      contextCount: task.context.length
    });
  }

  const stages = [...new Set(plan.tasks.map(task => task.stage))].sort((a, b) => a - b);
  sink.status(plan.tasks.length > 1 ? 'collecting' : 'thinking');

  for (const stage of stages) {
    if (sink.cancelled()) break;
    const tasks = plan.tasks.filter(task => task.stage === stage);
    // 上一轮的答案在这一轮开始时才填进去，Sequential 的因果方向不会反。
    if (stage > 0 && completedText.length > 0) {
      for (const task of tasks) task.context = [...completedText];
      for (const task of tasks) {
        const record = records.get(task.taskId);
        if (record) record.contextCount = task.context.length;
      }
    }

    for (let offset = 0; offset < tasks.length; offset += plan.concurrency) {
      if (sink.cancelled()) break;
      const batch = tasks.slice(offset, offset + plan.concurrency);
      await Promise.all(
        batch.map(task => runTask(task, pool, sink, records, channels, answers, messageIds, {
          now, retries, onRecord: options.onRecord
        }))
      );
    }

    // 保持花名册顺序，不按完成顺序：界面上的答案卡片不该每次都换位置。
    const stageText = tasks
      .map(task => records.get(task.taskId))
      .filter((record): record is CollaborationRecord => record?.status === 'done' && Boolean(record.text))
      .map(record => record.text as string);
    completedText.push(...stageText);
  }

  const failures = channels
    .filter((item): item is Extract<ChannelOutcome, { kind: 'unanswered' }> => item.kind === 'unanswered')
    .map(item => `${item.label}：${item.detail}`);

  let synthesis: ResearchOutcome['synthesis'] = null;
  if (!sink.cancelled() && answers.length >= 2) {
    sink.status('synthesizing');
    synthesis = synthesize(
      answers.map(answer => ({
        channelId: answer.agentId,
        messageId: messageIds.get(answer.agentId) ?? '',
        text: answer.text
      }))
    );
  }

  return {
    outcome: { answers, synthesis, failures, channels },
    records: plan.tasks.map(task => records.get(task.taskId)!),
    plan
  };
}

async function runTask(
  task: CollaborationTask,
  pool: SubAgentPool,
  sink: ResearchSink,
  records: Map<string, CollaborationRecord>,
  channels: ChannelOutcome[],
  answers: SubAgentAnswer[],
  messageIds: Map<string, string>,
  options: { now: () => number; retries: number; onRecord?: (record: CollaborationRecord) => void }
): Promise<void> {
  const record = records.get(task.taskId)!;
  const publish = () => options.onRecord?.({ ...record });
  record.status = 'running';
  record.startedAt = options.now();
  publish();
  sink.join(task.agentId);
  sink.phase(task.agentId, 'asking');

  let resetFailure: string | undefined;
  try {
    const reset = await pool.newConversation(task.agentId);
    if (!reset.ok) resetFailure = reset.detail;
  } catch (error) {
    resetFailure = error instanceof Error ? error.message : String(error);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (sink.cancelled()) {
      record.status = 'skipped';
      channels.push({ kind: 'cancelled', agentId: task.agentId, label: task.label });
      break;
    }
    record.attempts = attempt + 1;
    try {
      const answer = await pool.ask(task.agentId, {
        question: task.question,
        stage: task.stage === 0 ? 'initial' : 'followup',
        context: task.context.length > 0 ? task.context : undefined
      });
      const messageId = sink.record(answer);
      messageIds.set(task.agentId, messageId);
      answers.push(answer);
      channels.push({ kind: 'answered', agentId: task.agentId, label: task.label, answer, resetFailure });
      record.status = 'done';
      record.text = answer.text;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (record.status === 'running') {
    record.status = 'failed';
    record.error = lastError instanceof Error ? lastError.message : String(lastError ?? '未知原因');
    channels.push({
      kind: 'unanswered',
      agentId: task.agentId,
      label: task.label,
      phase: 'failed',
      detail: record.error
    });
  }

  record.endedAt = options.now();
  if (record.startedAt !== undefined) record.latencyMs = record.endedAt - record.startedAt;
  if (record.status === 'done') sink.phase(task.agentId, 'answered');
  else if (record.status === 'failed') sink.phase(task.agentId, 'failed', record.error);
  publish();
}

/** 适配 `MasterAgent` 的接口，让 `ConversationRunner` 不用认识两种执行器。 */
export class CollaborationResearch {
  private lastRecords: CollaborationRecord[] = [];
  private lastPlan: CollaborationPlan | null = null;

  constructor(
    private readonly pool: SubAgentPool,
    private readonly strategy: CollaborationStrategy,
    private readonly question: string,
    private readonly maxConcurrency?: number,
    private readonly onRecord?: (record: CollaborationRecord) => void
  ) {}

  records(): CollaborationRecord[] {
    return this.lastRecords;
  }

  plan(): CollaborationPlan | null {
    return this.lastPlan;
  }

  async research(_request: ResearchRequest, sink: ResearchSink): Promise<ResearchOutcome> {
    const agents = await this.pool.available();
    const plan = planCollaboration({
      strategy: this.strategy,
      question: this.question,
      agents: agents.map(agent => ({ id: agent.id, label: agent.label })),
      maxConcurrency: this.maxConcurrency
    });
    if (plan.tasks.length === 0) {
      throw new NoUsableAgentError(await describeUnusable(await this.pool.all()));
    }

    const result = await runCollaboration(this.pool, plan, sink, { onRecord: this.onRecord });
    this.lastRecords = result.records;
    this.lastPlan = result.plan;
    return result.outcome;
  }
}

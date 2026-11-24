/**
 * 工程执行事件 → 按步骤分组的纯模型（无 React、无 DOM）。
 *
 * 界面只负责画；「同一个 stepId 的 started / approval / completed / failed
 * 合成一张卡」「新的一轮不覆盖上一轮同名 step」这些规则在这里可单测。
 */

import type { AgentEvent } from './contracts';

export type StepStatus = 'preparing' | 'waiting' | 'running' | 'completed' | 'failed';

export interface StepCard {
  stepId: string;
  /**
   * 这一步属于哪一轮。
   *
   * 对话流要按轮次把「问了什么 → 谁答的 → 执行了什么」串起来；只靠 stepId
   * 分不出这是第几轮做的，计划修复时同一个 `step-1` 会在两轮里各出现一次。
   */
  roundId?: string | null;
  tool: string;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  args?: Record<string, unknown>;
  argsPreview?: string;
  risk?: 'read' | 'write' | 'danger';
  index?: number;
  total?: number;
  approval?: 'pending' | 'approved' | 'rejected';
  approvalReason?: string;
  result?: unknown;
  error?: string;
}

export type TimelineItem =
  | { kind: 'milestone'; key: string; at: number; roundId: string | null; text: string; tone: 'info' | 'ok' | 'warn' | 'error' | 'muted'; detail?: string }
  | { kind: 'step'; key: string; at: number; roundId: string | null; card: StepCard };

export const TOOL_NAME: Record<string, string> = {
  'fs.list': '列目录',
  'fs.readFile': '读文件',
  'fs.mkdir': '建目录',
  'fs.writeFile': '写文件',
  'fs.tree': '看结构',
  'fs.search': '搜代码',
  'fs.find': '找文件',
  'fs.stat': '看属性',
  'fs.edit': '改文件',
  'fs.remove': '删除',
  'fs.move': '移动',
  'fs.copy': '复制',
  'fs.readImage': '读图片',
  'fs.applyPatch': '打补丁',
  'fs.revert': '还原本轮',
  'test.run': '跑测试',
  'shell.run': '执行命令',
  'code.run': '跑代码',
  'code.definition': '找定义',
  'code.references': '找引用',
  'code.symbols': '看符号',
  'code.hover': '看类型',
  'code.context': '取上下文',
  'code.impact': '看影响面',
  'code.ast': '看语法树',
  'code.diagnostics': '跑诊断',
  'code.team.run': '多 Agent 编码',
  'project.outline': '看源码骨架',
  'project.dependencies': '看依赖',
  'git.status': '看 git 状态',
  'git.diff': '看 git diff',
  'git.log': '看提交记录',
  'job.list': '列作业',
  'job.output': '读作业输出',
  'job.kill': '停作业',
  'screen.capture': '截屏',
  'app.open': '打开应用',
  'clipboard.read': '读剪贴板',
  'clipboard.write': '写剪贴板',
  notify: '发通知',
  'system.info': '系统信息',
  'process.list': '列进程',
  'process.kill': '结束进程',
  'web.fetch': '抓网页',
  'web.search': '联网搜索'
};

export function toolLabel(tool: string) {
  return TOOL_NAME[tool] ?? tool;
}

/** 卡片头部那一行目标：路径 / 命令 / 查询词，按工具选一个最有信息量的。 */
export function target(tool: string, args?: Record<string, unknown>): string {
  if (!args) return '';
  const one = (key: string) => (typeof args[key] === 'string' ? String(args[key]) : '');
  const pairs = (keys: string[]) => keys.map(one).filter(Boolean).join(' · ');
  if (tool === 'shell.run' || tool === 'test.run' || tool === 'code.run') {
    return pairs(['command', 'language', 'path']);
  }
  if (tool === 'code.definition' || tool === 'code.references' || tool === 'code.impact' || tool === 'code.context') {
    const path = one('path');
    const line = typeof args.line === 'number' ? `:${String(args.line)}` : '';
    return `${path}${line}`;
  }
  if (tool === 'fs.search') return pairs(['query', 'path']);
  if (tool === 'fs.find') return pairs(['pattern', 'path']);
  if (tool === 'fs.move' || tool === 'fs.copy') return `${one('from')} → ${one('to')}`;
  return pairs(['path', 'from', 'to', 'name', 'url', 'task']);
}

export function duration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function statusText(card: StepCard): string {
  if (card.status === 'preparing') return '准备工具';
  if (card.status === 'waiting') return '等待确认';
  if (card.status === 'running') return '执行中';
  if (card.status === 'failed') return '失败';
  return '完成';
}

function roundType(inputType: string) {
  if (inputType === 'user_prompt') return '任务';
  if (inputType === 'execution_report') return '执行报告';
  if (inputType === 'plan_repair') return '计划修正';
  return '澄清回答';
}

function milestone(
  event: AgentEvent,
  index: number
): Omit<Extract<TimelineItem, { kind: 'milestone' }>, 'roundId'> | null {
  const key = `m-${String(event.at)}-${String(index)}`;
  switch (event.type) {
    case 'round.started':
      return { kind: 'milestone', key, at: event.at, text: `第 ${String(event.roundNumber)} 轮 · ${roundType(event.inputType)} 已发送`, tone: 'muted' };
    case 'round.answer': {
      const planAnswer = /"type"\s*:\s*"plan"/.test(event.text);
      return {
        kind: 'milestone',
        key,
        at: event.at,
        text: planAnswer ? '模型返回执行计划' : `模型回答（${String(event.text.length)} 字符）`,
        tone: 'info',
        ...(planAnswer ? {} : { detail: event.text })
      };
    }
    case 'plan.ready':
      // 不写「等待审批」：完全权限下这份计划已经自动批准了，说等待是假话。
      // 要不要人点，由审批卡和「计划已自动批准」那条日志说，不由这里猜。
      return { kind: 'milestone', key, at: event.at, text: `计划就绪：${event.plan.title}（${String(event.plan.steps.length)} 步）`, tone: 'info' };
    case 'plan.invalid':
      return { kind: 'milestone', key, at: event.at, text: `计划被拒绝：${event.error}`, tone: 'error' };
    case 'clarification.required':
      return { kind: 'milestone', key, at: event.at, text: `需要澄清：${event.questions.join(' / ')}`, tone: 'warn' };
    case 'report.ready':
      return {
        kind: 'milestone',
        key,
        at: event.at,
        text: `执行报告：${event.report.status} · ${String(event.report.results.filter(item => item.status === 'completed').length)} 步完成${event.report.verification ? ` · ${event.report.verification.verified ? '已验证' : '未验证'}` : ''}`,
        tone: event.report.status === 'completed' ? 'ok' : 'warn'
      };
    case 'review.ready':
      return {
        kind: 'milestone',
        key,
        at: event.at,
        text: `独立评审（${event.backend === 'rules' ? '规则版' : event.reviewer}）：${event.needsFix ? '需修复' : '通过'}`,
        tone: event.needsFix ? 'warn' : 'ok'
      };
    case 'plan.review.progress':
      // 固定 key：同一段评审的 started/waiting/done 聚成一条原地更新的节点。
      // 心跳每 10 秒把「已等 N 秒」写回同一行，对话流里始终能看见它在走；
      // 如果每条心跳都 push，三轮辩论几十条会把真正的回答挤出屏幕。
      return {
        kind: 'milestone', key: `plan-review-${event.roundId}`, at: event.at,
        text: event.state === 'started'
          ? `方案评审开始：${String(event.topics)} 个议题，等待成员意见…`
          : event.state === 'done'
            ? `方案评审等待结束（已等 ${String(Math.round(event.elapsedMs / 1000))} 秒）`
            : `方案评审进行中 · 已等 ${String(Math.round(event.elapsedMs / 1000))} 秒（${String(event.topics)} 个议题）`,
        tone: 'muted',
        ...((event.reason || event.roundsReason || (event.topicTexts && event.topicTexts.length > 0))
          ? {
              detail: [
                ...(event.reason ? [`为什么评审：${event.reason}`] : []),
                ...(event.maxRounds !== undefined
                  ? [`轮次：最多 ${String(event.maxRounds)} 轮，实际按分歧收敛${event.roundsReason ? `（${event.roundsReason}）` : ''}`]
                  : event.rounds !== undefined
                    ? [`轮次：实际 ${String(event.rounds)} 轮${event.roundsReason ? `（${event.roundsReason}）` : ''}`]
                    : []),
                ...(event.reason || event.maxRounds !== undefined || event.rounds !== undefined ? [''] : []),
                ...(event.topicTexts ?? []).map((topic, index) => `${String(index + 1)}. ${topic}`)
              ].join('\n')
            }
          : {})
      };
    case 'plan.debated':
      return {
        kind: 'milestone',
        key,
        at: event.at,
        text: event.debate.status === 'skipped'
          ? `方案评审未进行：${event.debate.skippedReason ?? '没有可用成员'}`
          : `方案评审已辩完（${event.debate.participants.join('、')}）：${String(event.debate.topics.length)} 个辩题`,
        tone: 'muted',
        ...(event.debate.topics.length > 0 || event.debate.summary
          ? {
              detail: [
                ...(event.debate.reason ? [`为什么评审：${event.debate.reason}`, ''] : []),
                ...event.debate.topics.map((topic, index) => `${String(index + 1)}. ${topic}`),
                ...(event.debate.summary ? ['', event.debate.summary] : [])
              ].join('\n')
            }
          : {})
      };
    case 'task.completed':
      return { kind: 'milestone', key, at: event.at, text: `任务完成${event.summary ? `：${event.summary}` : ''}`, tone: 'ok' };
    case 'task.failed':
      return { kind: 'milestone', key, at: event.at, text: `任务失败：${event.error}`, tone: 'error' };
    case 'task.cancelled':
      return { kind: 'milestone', key, at: event.at, text: '任务已取消', tone: 'warn' };
    case 'log':
      return {
        kind: 'milestone',
        key,
        at: event.at,
        text: event.message,
        tone: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'muted'
      };
    case 'context.event': {
      const labels: Record<string, string> = {
        'context.prepared': '上下文已准备',
        'context.budget.warning': '上下文接近上限',
        'context.compaction.started': '开始压缩上下文',
        'context.compaction.summary.ready': '摘要已生成',
        'context.compaction.committed': '上下文检查点已提交',
        'context.compaction.failed': '上下文压缩失败',
        'context.compaction.stale': '上下文摘要已过期',
        'context.recovered': '已从检查点恢复上下文'
      };
      return {
        kind: 'milestone',
        key,
        at: event.at,
        text: labels[event.event] ?? '上下文事件',
        tone: event.event === 'context.budget.warning' ? 'warn' : 'muted',
        detail: JSON.stringify(event.context, null, 2)
      };
    }
    default:
      return null;
  }
}

export function buildTimeline(events: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const byStep = new Map<string, StepCard>();
  /** 计划修复可能复用 step-1；按轮次分段，避免上一轮的卡被这一轮改写。 */
  let epoch = 0;
  /** 当前轮次 id：老事件可能没带 roundId，用最后一条 round.started 兜底。 */
  let currentRoundId: string | null = null;
  const at = (stepId: string) => `${String(epoch)}:${stepId}`;

  const upsert = (stepId: string, eventAt: number, patch: Partial<StepCard>): StepCard => {
    const key = at(stepId);
    let card = byStep.get(key);
    if (!card) {
      card = { stepId, roundId: currentRoundId, tool: '', status: 'running' };
      byStep.set(key, card);
      items.push({ kind: 'step', key: `step-${key}`, at: eventAt, roundId: currentRoundId, card });
    }
    Object.assign(card, patch);
    return card;
  };

  events.forEach((event, index) => {
    switch (event.type) {
      case 'step.preparing':
        upsert(event.stepId, event.at, {
          tool: event.tool,
          status: 'preparing',
          args: event.args
        });
        return;
      case 'step.started':
        upsert(event.stepId, event.at, {
          tool: event.tool,
          status: 'running',
          startedAt: event.at,
          args: event.args,
          argsPreview: undefined
        });
        return;
      case 'step.approval':
        upsert(event.stepId, event.at, {
          tool: event.tool,
          status: 'waiting',
          argsPreview: event.argsPreview,
          risk: event.risk,
          index: event.index,
          total: event.total,
          approval: 'pending'
        });
        return;
      case 'step.approval-resolved': {
        const card = byStep.get(at(event.stepId));
        if (card) {
          card.approval = event.approved ? 'approved' : 'rejected';
          card.approvalReason = event.reason;
          if (!event.approved) {
            card.status = 'failed';
            card.error = event.reason ?? '用户拒绝执行这一步';
          }
        }
        return;
      }
      case 'step.question': {
        const card = upsert(event.stepId, event.at, { tool: event.tool, status: 'waiting' });
        card.error = event.question;
        return;
      }
      case 'step.question-resolved': {
        const card = byStep.get(at(event.stepId));
        if (card && card.status === 'waiting') card.status = 'running';
        return;
      }
      case 'step.completed':
        upsert(event.stepId, event.at, {
          tool: event.tool,
          status: 'completed',
          endedAt: event.at,
          durationMs: event.durationMs,
          result: event.result
        });
        return;
      case 'step.failed':
        upsert(event.stepId, event.at, {
          tool: event.tool,
          status: 'failed',
          endedAt: event.at,
          durationMs: event.durationMs,
          args: event.args,
          error: event.error
        });
        return;
      default: {
        if (event.type === 'round.started') {
          epoch += 1;
          currentRoundId = event.roundId;
        }
        const item = milestone(event, index);
        if (item) {
          // 原地更新的里程碑（评审心跳）：同一 key 只留最新一条，且不挪动它在
          // 列表中的位置——否则每次心跳都会把「评审中」顶到对话最底下。
          const prior = item.key.startsWith('plan-review-')
            ? items.findIndex(existing => existing.kind === 'milestone' && existing.key === item.key)
            : -1;
          if (prior >= 0) items[prior] = { ...item, roundId: currentRoundId };
          else items.push({ ...item, roundId: currentRoundId });
        }
      }
    }
  });

  // 老事件没有 durationMs：用起止时间补，补不出来就不写。
  for (const card of byStep.values()) {
    if (card.durationMs === undefined && card.startedAt && card.endedAt) {
      card.durationMs = card.endedAt - card.startedAt;
    }
  }
  return items;
}

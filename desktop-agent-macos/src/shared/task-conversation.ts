/**
 * 工程任务 → 一条按时间推进的对话流（纯投影，无 React、无 DOM）。
 *
 * 为什么需要它：对话页原先只画「当前状态」——最新一轮的成员输出、最新的验证、
 * 最新的评审。于是后面一轮把前面一轮覆盖掉，中间执行过程只在输出页的执行日志里，
 * 最后也没有一句话的结论。对话是主界面，它必须像一次真实的协作记录：
 *
 *   我提了什么 → 谁怎么答的 → 中间真跑了什么 → 每一轮的结论 → 最后的结论
 *
 * 规则：
 * - 成员按 `roundId + memberId` 累积，新一轮**不清空**上一轮的卡片；
 * - 执行步骤直接复用 `buildTimeline`（它已经做到同一 stepId 跨轮不串）；
 * - 协议 JSON（`desktop-agent/v1`）照实保留原文，但单独标出来，不让它冒充结论；
 * - 结论只写真实发生过的事：`task.completed.summary`、执行报告、验证、评审。
 */

import type { AgentEvent } from './contracts';
import { buildTimeline, type StepCard } from './execution-timeline';
import { artifactPaths } from './task-view';

export type ConversationTone = 'info' | 'ok' | 'warn' | 'error' | 'muted';

export type ConversationProtocol =
  | 'plan'
  | 'execution_report'
  | 'clarification_required'
  | 'task_complete'
  | null;

export interface ConversationEntryBase {
  key: string;
  at: number;
  roundId: string | null;
  roundNumber: number | null;
}

export type ConversationEntry =
  | (ConversationEntryBase & { kind: 'user'; text: string })
  | (ConversationEntryBase & { kind: 'note'; text: string; tone: ConversationTone; detail?: string })
  | (ConversationEntryBase & {
      kind: 'member';
      memberId: string;
      label: string;
      status: 'streaming' | 'completed' | 'failed' | 'cancelled';
      text: string;
      reasoning: string;
      reasoningSupported: boolean;
      durationMs: number | null;
      error: string | null;
      protocol: ConversationProtocol;
    })
  | (ConversationEntryBase & { kind: 'step'; card: StepCard })
  | (ConversationEntryBase & {
      kind: 'conclusion';
      text: string;
      facts: string[];
      tone: ConversationTone;
    });

/**
 * 去掉 Markdown 代码围栏。
 *
 * 模型经常把协议写成 ```json … ``` 交回来；直接 JSON.parse 会失败，于是整段
 * 机器 JSON 被当成正文铺满屏幕——真机第一次验证就是这个样子。
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/**
 * 认出协议对象。
 *
 * 模型在工程空间里返回的是 `desktop-agent/v1` 的 JSON（计划 / 执行报告 /
 * 澄清请求 / 完成消息）。原文必须留着（它是证据），但它不是「给我的结论」，
 * 界面上要分开写，否则用户读到的最后一句就是一大段机器 JSON。
 */
export function protocolKind(text: string): ConversationProtocol {
  const body = unfence(text);
  if (!body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body) as { protocol?: unknown; type?: unknown };
    if (parsed.protocol !== 'desktop-agent/v1') return null;
    // `clarification_required` 才是协议里的真值；旧的 request 写法留着兼容。
    if (parsed.type === 'clarification_required' || parsed.type === 'clarification_request') {
      return 'clarification_required';
    }
    if (parsed.type === 'plan' || parsed.type === 'execution_report' || parsed.type === 'task_complete') {
      return parsed.type;
    }
    return null;
  } catch {
    return null;
  }
}

/** 协议对象里那句给人看的话：`summary` 优先，计划退到标题。 */
export function protocolSummary(text: string): string | null {
  try {
    const parsed = JSON.parse(unfence(text)) as {
      summary?: unknown;
      title?: unknown;
      plan?: { title?: unknown };
    };
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) return parsed.summary.trim();
    // 计划标题有两种落点：顶层 `title`（模型常见写法）与 `plan.title`。
    if (typeof parsed.plan?.title === 'string' && parsed.plan.title.trim()) return parsed.plan.title.trim();
    if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title.trim();
    return null;
  } catch {
    return null;
  }
}

/**
 * 只取 `summary` 字段，不拿计划标题凑数。
 *
 * 结论卡写「写文件」这种事毫无意义——那是计划的标题，不是这件事的结果。
 * 成员卡可以用标题当一句话摘要，结论不行。
 */
function protocolConclusionText(text: string): string | null {
  try {
    const parsed = JSON.parse(unfence(text)) as { summary?: unknown };
    return typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : null;
  } catch {
    return null;
  }
}

/** 超时/取消这类没有 summary 的收尾，至少要有一句事实。 */
function statusText(status: string | undefined): string {
  if (status === 'failed') return '任务失败';
  if (status === 'cancelled') return '任务已取消';
  if (status === 'completed') return '任务完成';
  return '任务尚未结束';
}

interface MemberAcc {
  key: string;
  roundId: string;
  memberId: string;
  label: string;
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  text: string;
  reasoning: string;
  reasoningSupported: boolean;
  startedAt: number;
  durationMs: number | null;
  error: string | null;
}

function appendText(current: string, incoming: string | undefined, mode: 'snapshot' | 'delta'): string {
  if (!incoming) return current;
  return mode === 'delta' ? current + incoming : incoming;
}

/**
 * 把事件折成对话条目。
 *
 * `prompt` 传任务原话：`round.started` 只带 inputType，不带用户原话，而「我问了
 * 什么」是这条流的第一句。后续轮次不是用户提问（执行报告 / 澄清回答 / 计划修正），
 * 用 `note` 说清楚这一轮为什么开始。
 */
export function buildTaskConversation(
  events: readonly AgentEvent[],
  options: {
    prompt?: string;
    summary?: string;
    status?: string;
    /** 运行中最后一段流式文本：还没有 `round.answer` 时也要能看到字在出。 */
    live?: {
      roundId: string | null;
      text: string;
      reasoning: string;
      providerId: string | null;
      modelId: string | null;
    } | null;
    now?: number;
  } = {}
): ConversationEntry[] {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const entries: ConversationEntry[] = [];
  const rounds = new Map<string, { number: number; inputType: string; at: number }>();
  const members = new Map<string, MemberAcc>();
  let currentRoundId: string | null = null;
  let firstRound: { roundId: string; at: number } | null = null;
  let seq = 0;
  let lastAt = ordered[0]?.at ?? Date.now();

  const push = (entry: ConversationEntry) => {
    entries.push(entry);
    seq += 1;
  };
  const roundOf = (roundId: string | null) => (roundId ? rounds.get(roundId) ?? null : null);
  const roundNumber = (roundId: string | null) => roundOf(roundId)?.number ?? null;

  const memberEntry = (acc: MemberAcc): ConversationEntry => ({
    kind: 'member',
    key: acc.key,
    at: acc.startedAt,
    roundId: acc.roundId,
    roundNumber: roundNumber(acc.roundId),
    memberId: acc.memberId,
    label: acc.label,
    status: acc.status,
    text: acc.text,
    reasoning: acc.reasoning,
    reasoningSupported: acc.reasoningSupported,
    durationMs: acc.durationMs,
    error: acc.error,
    protocol: protocolKind(acc.text)
  });

  const upsertMember = (
    roundId: string,
    memberId: string,
    patch: Partial<Omit<MemberAcc, 'key' | 'roundId' | 'memberId'>>
  ): MemberAcc => {
    const key = `${roundId}::${memberId}`;
    let acc = members.get(key);
    if (!acc) {
      acc = {
        key,
        roundId,
        memberId,
        label: memberId,
        status: 'streaming',
        text: '',
        reasoning: '',
        reasoningSupported: false,
        startedAt: lastAt,
        durationMs: null,
        error: null
      };
      members.set(key, acc);
    }
    Object.assign(acc, patch);
    // 每次都重画这一条：成员卡的正文是逐步长的，条目必须跟着最新状态。
    const index = entries.findIndex(entry => entry.key === key);
    if (index >= 0) entries[index] = memberEntry(acc);
    else entries.push(memberEntry(acc));
    return acc;
  };

  for (const event of ordered) {
    lastAt = event.at;
    if (event.type === 'round.started') {
      currentRoundId = event.roundId;
      if (!firstRound) firstRound = { roundId: event.roundId, at: event.at };
      rounds.set(event.roundId, {
        number: event.roundNumber,
        inputType: event.inputType,
        at: event.at
      });
      push({
        kind: 'note',
        key: `round-${event.roundId}`,
        at: event.at,
        roundId: event.roundId,
        roundNumber: event.roundNumber,
        tone: 'muted',
        text:
          event.inputType === 'user_prompt'
            ? `第 ${String(event.roundNumber)} 轮 · 提问`
            : event.inputType === 'execution_report'
              ? `第 ${String(event.roundNumber)} 轮 · 执行报告已发回模型`
              : event.inputType === 'plan_repair'
                ? `第 ${String(event.roundNumber)} 轮 · 计划修正`
                : `第 ${String(event.roundNumber)} 轮 · 补充回答已发回模型`
      });
      continue;
    }

    if (event.type === 'round.peer') {
      const roundId = event.roundId ?? currentRoundId;
      if (!roundId) continue;
      const memberId = event.memberId;
      if (event.status === 'started') {
        upsertMember(roundId, memberId, {
          label: event.label || event.modelId || event.providerId || memberId,
          status: 'streaming',
          startedAt: event.at
        });
      } else if (event.status === 'answered') {
        upsertMember(roundId, memberId, {
          label: event.label || event.modelId || event.providerId || memberId,
          status: 'completed',
          text: event.text ?? '',
          // 方案评审成员与第一轮回答共用这张卡：推理也要带过来，否则用户只能
          // 看到结论，看不到它为什么这么评。
          reasoning: event.reasoning ?? '',
          reasoningSupported: Boolean(event.reasoning),
          durationMs: event.durationMs ?? null
        });
      } else {
        upsertMember(roundId, memberId, {
          label: event.label || event.modelId || event.providerId || memberId,
          status: event.status === 'failed' ? 'failed' : 'cancelled',
          error: event.error ?? null,
          durationMs: event.durationMs ?? null
        });
      }
      continue;
    }

    if (event.type === 'round.delta') {
      const roundId = event.roundId ?? currentRoundId;
      if (!roundId) continue;
      // 没有 participantId 的旧事件属于主导这一路：用 `lead` 收，和 round.answer 对齐。
      const memberId = event.participantId ?? 'lead';
      const existing = members.get(`${roundId}::${memberId}`);
      const mode = event.mode ?? 'snapshot';
      upsertMember(roundId, memberId, {
        label: existing?.label ?? event.modelId ?? event.providerId ?? (memberId === 'lead' ? '本轮主导模型' : memberId),
        status: existing?.status === 'completed' ? 'completed' : 'streaming',
        text: event.reset === true ? (event.text ?? '') : appendText(existing?.text ?? '', event.text, mode),
        reasoning: event.reset === true ? (event.reasoning ?? '') : appendText(existing?.reasoning ?? '', event.reasoning, mode),
        reasoningSupported: existing?.reasoningSupported === true || Boolean(event.reasoning),
        startedAt: existing?.startedAt ?? event.at
      });
      continue;
    }

    if (event.type === 'round.answer') {
      const roundId = event.roundId ?? currentRoundId;
      if (!roundId) continue;
      const memberId = event.participantId ?? 'lead';
      const existing = members.get(`${roundId}::${memberId}`);
      upsertMember(roundId, memberId, {
        status: 'completed',
        // `round.answer` 是落盘前最后一份原文，以它为准。
        text: event.text,
        durationMs: existing ? Math.max(0, event.at - existing.startedAt) : null,
        startedAt: existing?.startedAt ?? event.at
      });
      continue;
    }

    if (event.type === 'clarification.required') {
      push({
        kind: 'note',
        key: `clarify-${String(event.at)}-${String(seq)}`,
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId),
        tone: 'warn',
        text: '模型需要你补充信息',
        detail: event.questions.join('\n')
      });
      continue;
    }

    if (event.type === 'review.ready') {
      push({
        kind: 'note',
        key: `review-${String(event.at)}-${String(seq)}`,
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId),
        tone: event.needsFix ? 'warn' : 'ok',
        text: `独立评审（${event.backend === 'rules' ? '本机规则版' : event.reviewer}）：${event.needsFix ? '需修复' : '通过'}`,
        detail: [event.verdict, ...event.issues.map((issue, index) => `${String(index + 1)}. ${issue}`)]
          .filter(Boolean)
          .join('\n')
      });
      continue;
    }

    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
      continue;
    }
  }

  // 执行步骤与里程碑：复用已经验证过的分轮逻辑，再把它们按时间并进同一条流。
  for (const item of buildTimeline(ordered)) {
    const roundId = item.roundId ?? currentRoundId;
    if (item.kind === 'step') {
      // 计划一就绪就为每一步生成 preparing 卡，评审阶段还没执行，卡片里
      // 没有任何输出——真机上就成了一排「这一步没有可展示的输出」，用户
      // 以为界面坏了。真正执行时同一个 stepId 会更新成有输出的卡，这里
      // 只跳过尚未开始、也没有参数可看的空壳。
      if (item.card.status === 'preparing' && !item.card.startedAt && !item.card.args) continue;
      push({
        kind: 'step',
        key: `step-${item.key}`,
        at: item.at,
        roundId,
        roundNumber: roundNumber(roundId),
        card: item.card
      });
    } else {
      // 轮次头、评审已经有自己的条目，避免一句话说两遍。
      if (/^第 \d+ 轮/.test(item.text) || item.text.startsWith('独立评审')) continue;
      // 成员卡的正文就是这条回答：再写一行「模型回答（310 字符）」只是噪音。
      if (/^模型回答（/.test(item.text) || item.text === '模型返回执行计划') continue;
      // 完成摘要留给末尾的结论卡，这里只标时间点。
      const text = item.text.startsWith('任务完成：') ? '任务完成' : item.text;
      push({
        kind: 'note',
        key: `note-${item.key}`,
        at: item.at,
        roundId,
        roundNumber: roundNumber(roundId),
        tone: item.tone,
        text,
        ...(item.detail ? { detail: item.detail } : {})
      });
    }
  }

  // 用户原话排最前：它发生在第一轮之前，但人读对话时它就是第一句。
  const prompt = (options.prompt ?? '').trim();
  if (prompt) {
    push({
      kind: 'user',
      key: 'user-prompt',
      at: (firstRound?.at ?? ordered[0]?.at ?? Date.now()) - 1,
      roundId: firstRound?.roundId ?? null,
      roundNumber: 1,
      text: prompt
    });
  }

  // 还没结算的流式文本：只在最后一路、且这一轮没有 round.answer 时补一条。
  const live = options.live ?? null;
  if (live && live.roundId && (live.text || live.reasoning)) {
    const settled = ordered.some(event => event.type === 'round.answer' && event.roundId === live.roundId);
    if (!settled) {
      // 主导的 participantId 带 provider 前缀（如 `lead:OpenCode Go · deepseek-v4.1-flash`），
      // 不能硬编码 'lead' 另起一张卡——否则同一模型在界面上出现两张「输出中」。
      // 先找这一轮已经由 round.peer/delta 建好的流式成员，把 live 并进那一张。
      const prefix = `${live.roundId}::`;
      const liveAcc = [...members.values()].find(
        acc => acc.roundId === live.roundId && acc.status === 'streaming'
      ) ?? [...members.values()].find(acc => acc.key.startsWith(prefix) && acc.status !== 'completed');
      const memberId = liveAcc?.memberId ?? 'lead';
      upsertMember(live.roundId, memberId, {
        label: liveAcc?.label ?? live.modelId ?? live.providerId ?? '本轮主导模型',
        status: 'streaming',
        // live 是 TaskStreamState 的累积快照（含这一刻已出的全部文本），以它为准；
        // 没有 live 内容时才退回事件卡的文本，避免把更全的快照丢掉。
        text: live.text || liveAcc?.text || '',
        reasoning: live.reasoning || liveAcc?.reasoning || '',
        reasoningSupported: liveAcc?.reasoningSupported === true || Boolean(live.reasoning),
        startedAt: liveAcc?.startedAt ?? lastAt
      });
    }
  }

  const conclusion = buildConclusion(ordered, options);
  if (conclusion) {
    push({
      kind: 'conclusion',
      key: 'conclusion',
      at: lastAt + 1,
      roundId: currentRoundId,
      roundNumber: roundNumber(currentRoundId),
      text: conclusion.text,
      facts: conclusion.facts,
      tone: conclusion.tone
    });
  }

  return entries.sort((a, b) => a.at - b.at || orderWeight(a) - orderWeight(b));
}

/** 同一毫秒里的稳定次序：提问在最前，结论在最后。 */
function orderWeight(entry: ConversationEntry): number {
  if (entry.kind === 'user') return -2;
  if (entry.kind === 'conclusion') return 2;
  return 0;
}

/**
 * 最后那句话。
 *
 * 只认三种来源：任务自己的 `summary`、最后一次 `round.answer` 里协议对象的
 * `summary`、执行报告与评审的事实。一个都没有就写清「没有结论文本」，绝不
 * 拿一段 JSON 或一句「任务完成」冒充结论。
 */
export function buildConclusion(
  events: readonly AgentEvent[],
  options: { summary?: string; status?: string } = {}
): { text: string; facts: string[]; tone: ConversationTone } | null {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const completed = [...ordered].reverse().find(event => event.type === 'task.completed');
  const failed = [...ordered].reverse().find(event => event.type === 'task.failed');
  const cancelled = [...ordered].reverse().find(event => event.type === 'task.cancelled');
  const report = [...ordered].reverse().find(event => event.type === 'report.ready');
  const review = [...ordered].reverse().find(event => event.type === 'review.ready');
  const lastAnswer = [...ordered].reverse().find(event => event.type === 'round.answer');

  const status = options.status ?? (failed ? 'failed' : cancelled ? 'cancelled' : completed ? 'completed' : 'running');
  // 只有结算过的任务才有「结论」：进行中写一句结论等于替模型下判断。
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return null;

  const candidates = [
    options.summary,
    completed?.type === 'task.completed' ? completed.summary : undefined,
    lastAnswer?.type === 'round.answer' ? protocolConclusionText(lastAnswer.text) : undefined
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  // 协议 JSON 不是结论，哪怕它带着 summary 字段也已经被上面提取过了。
  const text = candidates.find(item => !protocolKind(item)) ?? '';

  const facts: string[] = [];
  if (report?.type === 'report.ready') {
    const done = report.report.results.filter(item => item.status === 'completed').length;
    facts.push(`执行 ${String(report.report.results.length)} 步，完成 ${String(done)} 步`);
    if (report.report.verification) {
      const checks = report.report.verification.checks;
      const ran = checks ? [checks.compile, checks.tests, checks.diagnostics].some(item => item.status !== 'skipped') : true;
      facts.push(
        report.report.verification.verified
          ? '验证通过'
          : ran
            ? '验证未通过'
            : '没有跑验证'
      );
      if (typeof report.report.verification.changedFiles === 'number') {
        facts.push(`改动 ${String(report.report.verification.changedFiles)} 个文件`);
      }
    }
    const artifacts = new Set<string>();
    for (const item of report.report.results ?? []) {
      const result = item.result as { stdout?: string; stderr?: string; cwd?: string } | undefined;
      if (!result) continue;
      for (const match of artifactPaths(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
        artifacts.add(/^(\/|[A-Za-z]:[\\/])/.test(match)
          ? match
          : result.cwd ? `${result.cwd.replace(/\/$/, '')}/${match}` : match);
      }
    }
    for (const rawCheck of Object.values(report.report.verification?.checks ?? {})) {
      const check = rawCheck as { output?: string };
      if (typeof check.output === 'string') {
        for (const match of artifactPaths(check.output)) artifacts.add(match);
      }
    }
    if (artifacts.size > 0) facts.push(`工程产物 ${String(artifacts.size)} 个`);
  }
  if (review?.type === 'review.ready') {
    facts.push(`独立评审：${review.needsFix ? `需修复（${String(review.issues.length)} 项）` : '通过'}`);
  }

  const tone: ConversationTone = status === 'failed' ? 'error' : status === 'cancelled' ? 'warn' : 'ok';
  return {
    text: text || (status === 'failed'
      ? (failed?.type === 'task.failed' ? failed.error : '任务失败，没有留下结论文本。')
      : status === 'cancelled'
        ? '任务已取消，没有留下结论文本。'
        : `${statusText(status)}，模型没有给出结论文本；以下是真实执行结果。`),
    facts,
    tone
  };
}

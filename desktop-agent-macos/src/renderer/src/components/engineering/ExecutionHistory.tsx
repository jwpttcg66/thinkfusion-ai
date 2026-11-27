import React, { useCallback, useEffect, useState } from 'react';
import type { ExecutionRecord } from '../../../../shared/execution-history';
import type { EvidenceRef } from '../../../../shared/engineering-evidence';

/**
 * 执行历史（V4 P1 M1-1）。
 *
 * 一个任务真正做过几次执行，以前只能从对话流里数；这里按轮次把它们逐条列出来，
 * 每条带自己的成员、步骤、证据、交付与失败原因。后面的轮次不覆盖前面的轮次。
 *
 * 数据来自主进程 store 的 rounds + reports + events 投影，不是界面已收到的事件片段
 * （事件按任务配额裁剪过，只看事件会让早先的执行凭空消失）。
 */

const INPUT_TYPE_LABEL: Record<string, string> = {
  user_prompt: '任务',
  execution_report: '执行报告',
  plan_repair: '计划修正',
  clarification_answer: '澄清回答'
};

const OUTCOME_LABEL: Record<string, string> = {
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
};

function formatDuration(ms: number | null): string {
  if (ms === null) return '未记录';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)} 分 ${String(seconds)} 秒`;
}

function formatTime(at: number | null): string {
  if (at === null) return '未记录';
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

function evidenceLabel(ref: EvidenceRef): string {
  if (ref.kind === 'file') {
    const line = typeof ref.line === 'number' ? `:${String(ref.line)}` : '';
    const hash = ref.sha256 ? ` · ${ref.sha256.slice(0, 8)}` : '';
    const lines = typeof ref.lines === 'number' ? ` · ${String(ref.lines)} 行` : '';
    return `${ref.path}${line}${lines}${hash}`;
  }
  if (ref.kind === 'url') return ref.url;
  const exit = ref.exitCode === null ? (ref.background ? '后台作业，无退出码' : '无退出码') : `退出码 ${String(ref.exitCode)}`;
  return `${ref.command} → ${exit}${ref.timedOut ? '（超时）' : ''}`;
}

function outcomeLabel(record: ExecutionRecord): string {
  if (record.outcome) return OUTCOME_LABEL[record.outcome] ?? record.outcome;
  if (record.roundStatus === 'failed') return '轮次失败（无执行报告）';
  if (record.roundStatus === 'cancelled') return '已取消（无执行报告）';
  return '未收口';
}

function outcomeTone(record: ExecutionRecord): string {
  if (record.outcome === 'completed') return 'ok';
  if (record.outcome === 'failed' || record.roundStatus === 'failed') return 'error';
  if (record.outcome === 'partial' || record.failureReasons.length > 0) return 'warn';
  return 'muted';
}

function verificationLabel(record: ExecutionRecord): string {
  if (!record.sources.report) return '本轮没有执行报告';
  if (record.verified === null) return '未记录验证';
  if (record.verified === true) {
    return record.fullyVerified === true ? '已验证（编译/运行/测试/诊断全过）' : '已验证';
  }
  return '未通过验证';
}

function stepsLabel(record: ExecutionRecord): string {
  if (record.steps.unknown) return '未记录步骤';
  const { total, completed, failed, skipped } = record.steps;
  const parts = [`${String(completed)}/${String(total)} 完成`];
  if (failed > 0) parts.push(`${String(failed)} 失败`);
  if (skipped > 0) parts.push(`${String(skipped)} 跳过`);
  return parts.join(' · ');
}

function EvidenceList({ refs }: { refs: EvidenceRef[] }) {
  if (refs.length === 0) return <p className="muted">这一轮没有记录到证据。</p>;
  const head = refs.slice(0, 6);
  const rest = refs.slice(6);
  return (
    <div className="exec-evidence">
      <ul>
        {head.map((ref, index) => (
          <li key={`${ref.kind}-${String(index)}`}>
            <span className="exec-evidence-kind">{ref.kind}</span>
            <code title={evidenceLabel(ref)}>{evidenceLabel(ref)}</code>
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <details>
          <summary>还有 {rest.length} 条证据</summary>
          <ul>
            {rest.map((ref, index) => (
              <li key={`rest-${String(index)}`}>
                <span className="exec-evidence-kind">{ref.kind}</span>
                <code title={evidenceLabel(ref)}>{evidenceLabel(ref)}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ExecutionItem({ record, index }: { record: ExecutionRecord; index: number }) {
  const ordinal = record.roundNumber ?? index + 1;
  return (
    <article className="exec-item">
      <header className="exec-item-head">
        <b>执行 #{String(ordinal)}</b>
        <span className="muted">{record.inputType ? INPUT_TYPE_LABEL[record.inputType] ?? record.inputType : '轮次未记录'}</span>
        <span className={`exec-chip ${outcomeTone(record)}`}>{outcomeLabel(record)}</span>
        <span className="muted">{formatTime(record.startedAt)} → {record.endedAt === null ? '进行中' : formatTime(record.endedAt)}</span>
        <span className="muted">用时 {formatDuration(record.durationMs)}</span>
      </header>

      <div className="stats-grid">
        <div>
          <span className="task-progress-key">成员</span>
          <b>
            {record.participants.length > 0
              ? record.participants.map(item => `${item.label}${item.status ? `（${item.status}）` : ''}`).join('、')
              : '未记录成员身份'}
          </b>
        </div>
        <div>
          <span className="task-progress-key">步骤</span>
          <b>{stepsLabel(record)}</b>
        </div>
        <div>
          <span className="task-progress-key">验证</span>
          <b>{verificationLabel(record)}</b>
        </div>
        <div>
          <span className="task-progress-key">改动文件</span>
          <b>{record.changedFiles === null ? '未记录' : String(record.changedFiles)}</b>
        </div>
        <div>
          <span className="task-progress-key">下一步</span>
          <b>{record.nextAction ?? '未记录'}</b>
        </div>
        <div>
          <span className="task-progress-key">runId</span>
          <b title={record.runId ?? ''}>{record.runId ? record.runId.slice(0, 8) : '未记录'}</b>
        </div>
      </div>

      {record.deliverables.length > 0 ? (
        <p className="exec-line">
          <span className="task-progress-key">交付</span>
          {record.deliverables.join('、')}
        </p>
      ) : (
        <p className="exec-line muted">
          <span className="task-progress-key">交付</span>
          {record.sources.report ? '这一轮没有记录到交付文件' : '这一轮没有执行报告，交付未记录'}
        </p>
      )}

      {record.failureReasons.length > 0 && (
        <ul className="exec-failures">
          {record.failureReasons.map((reason, i) => (
            <li key={`${String(i)}-${reason}`}>{reason}</li>
          ))}
        </ul>
      )}

      <EvidenceList refs={record.evidenceRefs} />

      <p className="exec-sources muted">
        依据：{record.sources.round ? '轮次记录' : '无轮次记录'} · {record.sources.report ? '执行报告' : '无执行报告'} ·{' '}
        {String(record.sources.events)} 条轮内事件{record.planId ? ` · plan ${record.planId.slice(0, 8)}` : ''}
      </p>
    </article>
  );
}

export function ExecutionHistory({ taskId, refreshKey = 0 }: { taskId: string; refreshKey?: number }) {
  const [records, setRecords] = useState<ExecutionRecord[] | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRecords(await window.agentAPI.getTaskExecutions(taskId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [taskId]);

  useEffect(() => {
    setRecords(null);
    setError('');
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (refreshKey > 0) void refresh();
  }, [refreshKey, refresh]);

  const count = records?.length ?? 0;
  const failedCount = records?.filter(item => item.outcome === 'failed' || item.roundStatus === 'failed').length ?? 0;

  return (
    <section className="card">
      <div className="card-head">
        <h2>执行历史</h2>
        <span className="muted">
          {records === null ? '读取中…' : `${String(count)} 次执行`}
          {failedCount > 0 ? ` · ${String(failedCount)} 次失败` : ''}
        </span>
      </div>
      {error && <p className="settings-error">{error}</p>}
      {records !== null && records.length === 0 && !error && <p className="muted">这个任务还没有记录到执行。</p>}
      {records?.map((record, index) => <ExecutionItem key={record.executionId} record={record} index={index} />)}
    </section>
  );
}

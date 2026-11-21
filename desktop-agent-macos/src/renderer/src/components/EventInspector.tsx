import React from 'react';
import type { ObservabilityEvent } from '../../../shared/observability';
import { maskSecrets } from '../../../shared/observability';

type Payload = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function CommandDetails(props: { result: Payload }) {
  const { result } = props;
  return (
    <>
      {typeof result.command === 'string' && <p><b>命令：</b><code>{result.command}</code></p>}
      {typeof result.cwd === 'string' && <p><b>工作目录：</b><code>{result.cwd}</code></p>}
      <p>
        <b>退出码：</b>{String(result.exitCode ?? '—')}
        {typeof result.durationMs === 'number' ? ` · ${String(result.durationMs)}ms` : ''}
        {result.timedOut === true ? ' · 超时' : ''}
        {result.truncated === true ? ' · 输出截断' : ''}
      </p>
      {typeof result.stdout === 'string' && result.stdout && (
        <><h5>stdout</h5><pre>{result.stdout}</pre></>
      )}
      {typeof result.stderr === 'string' && result.stderr && (
        <><h5>stderr</h5><pre className="is-error">{result.stderr}</pre></>
      )}
    </>
  );
}

function FileDetails(props: { result: Payload }) {
  const { result } = props;
  return (
    <>
      {typeof result.path === 'string' && <p><b>文件：</b><code>{result.path}</code></p>}
      {typeof result.sha256 === 'string' && <p><b>sha256：</b><code>{result.sha256}</code></p>}
      {typeof result.before === 'string' && typeof result.after === 'string' && (
        <>
          <h5>修改前</h5><pre>{result.before}</pre>
          <h5>修改后</h5><pre>{result.after}</pre>
        </>
      )}
      {typeof result.patch === 'string' && result.patch && (
        <><h5>Diff</h5><pre>{result.patch}</pre></>
      )}
      {typeof result.content === 'string' && result.content && (
        <><h5>内容</h5><pre>{result.content}</pre></>
      )}
    </>
  );
}

function ReportDetails(props: { payload: Payload }) {
  const report = props.payload.report as Payload | undefined;
  if (!report) return null;
  const verification = report.verification as Payload | undefined;
  const checks = verification?.checks as Payload | undefined;
  return (
    <>
      <p><b>报告状态：</b>{String(report.status ?? '—')}</p>
      {verification && <p><b>验证：</b>{verification.verified ? '通过' : '未通过'}</p>}
      {checks && (
        <p className="muted">
          编译 {String((checks.compile as Payload | undefined)?.status ?? '未执行')} ·
          测试 {String((checks.tests as Payload | undefined)?.status ?? '未执行')} ·
          诊断 {String((checks.diagnostics as Payload | undefined)?.status ?? '未执行')}
        </p>
      )}
      {Array.isArray(report.errors) && report.errors.length > 0 && (
        <><h5>错误</h5><pre>{text(report.errors)}</pre></>
      )}
    </>
  );
}

export function EventInspector(props: { event: ObservabilityEvent }) {
  const { event } = props;
  const payload = event.payload as Payload;
  const result = payload.result as Payload | undefined;
  const args = payload.args as Payload | undefined;
  return (
    <div className="event-inspector">
      <p className="muted">
        {event.category} · {event.phase} · seq {event.sequence} · {event.actor.label}
      </p>
      {event.roundId && <p className="muted">round {event.roundId}</p>}
      {event.stepId && <p className="muted">step {event.stepId}{event.callId ? ` · call ${event.callId}` : ''}</p>}

      {args && (
        <><h5>参数</h5><pre>{JSON.stringify(maskSecrets(args), null, 2)}</pre></>
      )}
      {payload.type === 'round.delta' && typeof payload.reasoning === 'string' && payload.reasoning && (
        <><h5>reasoning</h5><pre>{payload.reasoning}</pre></>
      )}
      {payload.type === 'round.delta' && typeof payload.text === 'string' && payload.text && (
        <><h5>assistant</h5><pre>{payload.text}</pre></>
      )}
      {result && typeof result === 'object' && (
        <>
          <h5>工具返回</h5>
          {'command' in result ? <CommandDetails result={result} /> : <FileDetails result={result} />}
        </>
      )}
      {payload.type === 'report.ready' && <ReportDetails payload={payload} />}
      {payload.type === 'review.ready' && (
        <>
          <p><b>评审：</b>{payload.needsFix ? '需修复' : '通过'}</p>
          {typeof payload.verdict === 'string' && <pre>{payload.verdict}</pre>}
        </>
      )}

      <details>
        <summary>原始事件</summary>
        <pre>{JSON.stringify(maskSecrets(payload), null, 2)}</pre>
      </details>
    </div>
  );
}

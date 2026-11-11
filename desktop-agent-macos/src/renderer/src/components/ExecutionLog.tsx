import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '../../../shared/contracts';
import {
  buildTimeline,
  duration,
  statusText,
  target,
  toolLabel,
  type StepCard,
  type TimelineItem
} from '../../../shared/execution-timeline';

export { toolLabel };

/**
 * 工程执行过程：按步骤分卡，而不是一行行文字。
 *
 * 一条 `完成 fs.edit` 看不出改了哪个文件、改了哪几行、写后有没有诊断；
 * 一条 `完成 code.definition` 也看不出跳到了哪一行。这里把同一个 stepId
 * 的 started / approval / completed / failed 合成一张卡：
 *
 *   头部：工具、目标（路径/命令/查询词）、状态、耗时
 *   展开：参数、代码证据（路径:行号/置信度）、diff、命令输出、诊断、错误
 *
 * 只渲染事件里真实带的东西：没有的参数不猜，没有的结果不补。
 */

function stringify(value: unknown, max = 6000): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${String(text.length)} 字符）` : text;
  } catch {
    return String(value);
  }
}

function lines(text: string, limit = 200): string[] {
  const all = text.split('\n');
  return all.length > limit ? [...all.slice(0, limit), `…（还有 ${String(all.length - limit)} 行）`] : all;
}

function CodeLocations(props: { items: unknown[] }) {
  const rows = props.items.slice(0, 40).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  if (rows.length === 0) return <p className="muted">没有返回位置。</p>;
  return (
    <ul className="exec-locations">
      {rows.map((item, index) => (
        <li key={index}>
          <code>{String(item.path ?? '')}:{String(item.line ?? '?')}:{String(item.character ?? '?')}</code>
          {typeof item.preview === 'string' && item.preview && <span>{item.preview}</span>}
        </li>
      ))}
    </ul>
  );
}

function ImpactView(props: { result: Record<string, unknown> }) {
  const definitions = Array.isArray(props.result.definitions) ? props.result.definitions : [];
  const relations = Array.isArray(props.result.relations) ? props.result.relations : [];
  const tests = Array.isArray(props.result.relatedTests) ? props.result.relatedTests : [];
  return (
    <div className="exec-impact">
      <p className="muted">
        {String(props.result.source ?? '')}
        {props.result.cached === true ? ' · 缓存命中' : ''}
      </p>
      <h5>定义（{String(definitions.length)}）</h5>
      <CodeLocations items={definitions} />
      <h5>引用 / 调用（{String(relations.length)}）</h5>
      {relations.length === 0 ? <p className="muted">没有引用。</p> : (
        <ul className="exec-locations">
          {relations.slice(0, 40).map((item, index) => {
            const row = item as Record<string, unknown>;
            const exact = row.confidence === 'EXACT';
            return (
              <li key={index}>
                <span className={`exec-badge ${exact ? 'is-exact' : 'is-possible'}`}>
                  {exact ? 'EXACT' : 'POSSIBLE'}
                </span>
                <span className={`exec-badge ${row.kind === 'call' ? 'is-call' : ''}`}>{String(row.kind ?? 'reference')}</span>
                <code>{String(row.path ?? '')}:{String(row.line ?? '?')}</code>
                {typeof row.preview === 'string' && row.preview && <span>{row.preview}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <h5>候选测试（{String(tests.length)}）</h5>
      <CodeLocations items={tests} />
    </div>
  );
}

function CommandView(props: { result: Record<string, unknown> }) {
  const { result } = props;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return (
    <div className="exec-command">
      <p className="muted">
        退出码 {String(result.exitCode ?? '—')}
        {typeof result.durationMs === 'number' ? ` · ${duration(result.durationMs)}` : ''}
        {result.timedOut === true ? ' · 超时' : ''}
        {result.truncated === true ? ' · 输出已截断' : ''}
      </p>
      {stdout && <pre className="exec-output">{lines(stdout).join('\n')}</pre>}
      {stderr && <pre className="exec-output is-error">{lines(stderr).join('\n')}</pre>}
      {!stdout && !stderr && <p className="muted">没有输出。</p>}
    </div>
  );
}

function DiffView(props: { before?: string; after?: string; patch?: string }) {
  if (props.patch) {
    return (
      <pre className="exec-diff">
        {props.patch.split('\n').map((line, index) => (
          <div key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'is-add' : line.startsWith('-') && !line.startsWith('---') ? 'is-del' : line.startsWith('@@') ? 'is-hunk' : ''}>
            {line || ' '}
          </div>
        ))}
      </pre>
    );
  }
  if (typeof props.before !== 'string' || typeof props.after !== 'string') return null;
  return (
    <pre className="exec-diff">
      {props.before.split('\n').map((line, index) => <div key={`b${String(index)}`} className="is-del">{`- ${line}`}</div>)}
      {props.after.split('\n').map((line, index) => <div key={`a${String(index)}`} className="is-add">{`+ ${line}`}</div>)}
    </pre>
  );
}

function TeamView(props: { result: Record<string, unknown> }) {
  const stages = Array.isArray(props.result.stages) ? props.result.stages : [];
  const patches = Array.isArray(props.result.patches) ? props.result.patches : [];
  const conflicts = Array.isArray(props.result.conflicts) ? props.result.conflicts : [];
  return (
    <div className="exec-team">
      <p className="muted">{String(props.result.note ?? '')}</p>
      <p>
        可应用：<b className={props.result.applyable === true ? 'is-ok' : 'is-bad'}>{props.result.applyable === true ? '是' : '否'}</b>
      </p>
      {stages.length > 0 && (
        <ul className="exec-locations">
          {stages.map((stage, index) => {
            const row = stage as Record<string, unknown>;
            return (
              <li key={index}>
                <span className={`exec-badge ${row.status === 'completed' ? 'is-exact' : 'is-possible'}`}>
                  {String(row.status ?? '')}
                </span>
                {String(row.name ?? '')}
                <span>{Array.isArray(row.agents) ? row.agents.join(' + ') : ''}</span>
              </li>
            );
          })}
        </ul>
      )}
      <h5>补丁（{String(patches.length)}）</h5>
      {patches.length === 0 ? <p className="muted">没有解析到补丁。</p> : (
        <ul className="exec-locations">
          {patches.map((patch, index) => {
            const row = patch as Record<string, unknown>;
            return (
              <li key={index}>
                <span className={`exec-badge ${row.valid === true ? 'is-exact' : 'is-possible'}`}>
                  {row.valid === true ? 'valid' : 'invalid'}
                </span>
                <code>{String(row.path ?? '')}</code>
                <span>+{String(row.additions ?? 0)} / -{String(row.deletions ?? 0)}</span>
                {typeof row.expectedHash === 'string' && <code className="exec-hash">expectedHash {row.expectedHash.slice(0, 12)}…</code>}
                {typeof row.reason === 'string' && <span className="is-bad">{row.reason}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {conflicts.length > 0 && (
        <>
          <h5>冲突</h5>
          <ul className="exec-locations">
            {conflicts.map((item, index) => {
              const row = item as Record<string, unknown>;
              return <li key={index}><code>{String(row.path ?? '')}</code><span>{Array.isArray(row.agents) ? row.agents.join(' / ') : ''}</span></li>;
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function ResultView(props: { card: StepCard }) {
  const { card } = props;
  const { tool, result, args } = card;
  if (result === undefined) return null;
  const data = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;

  if (tool === 'code.definition' || tool === 'code.references' || tool === 'code.symbols' || tool === 'code.ast') {
    if (Array.isArray(result)) return <CodeLocations items={result} />;
  }
  if (tool === 'code.impact' && data) return <ImpactView result={data} />;
  if (tool === 'code.hover' && data) {
    return (
      <div>
        <pre className="exec-code">{String(data.display ?? '')}</pre>
        {typeof data.documentation === 'string' && data.documentation && <pre className="exec-code">{data.documentation}</pre>}
      </div>
    );
  }
  if (tool === 'code.diagnostics' && data) {
    const counts = (data.counts ?? {}) as Record<string, unknown>;
    const issues = Array.isArray(data.issues) ? data.issues : [];
    return (
      <div>
        <p className="muted">
          {String(data.source ?? '')} · {String(counts.errors ?? 0)} error / {String(counts.warnings ?? 0)} warn
        </p>
        {issues.length === 0 ? <p className="muted">没有诊断问题。</p> : (
          <ul className="exec-locations">
            {issues.slice(0, 30).map((issue, index) => {
              const row = issue as Record<string, unknown>;
              return (
                <li key={index}>
                  <span className={`exec-badge ${row.severity === 'error' ? 'is-bad' : 'is-possible'}`}>{String(row.severity ?? '')}</span>
                  <code>{String(row.path ?? '')}:{String(row.line ?? '?')}:{String(row.column ?? '?')}</code>
                  <span>{String(row.message ?? '')}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }
  if ((tool === 'test.run' || tool === 'shell.run' || tool === 'code.run') && data) return <CommandView result={data} />;
  if ((tool === 'fs.edit' || tool === 'fs.writeFile' || tool === 'fs.applyPatch') && data) {
    return (
      <div>
        <p className="muted">
          {String(data.path ?? args?.path ?? '')}
          {typeof data.replaced === 'number' ? ` · 替换 ${String(data.replaced)} 处` : ''}
          {typeof data.bytes === 'number' ? ` · ${String(data.bytes)} 字节` : ''}
          {typeof data.hunks === 'number' ? ` · ${String(data.hunks)} 个 hunk` : ''}
        </p>
        <DiffView
          before={typeof data.before === 'string' ? data.before : typeof args?.oldString === 'string' ? args.oldString : undefined}
          after={typeof data.after === 'string' ? data.after : typeof args?.newString === 'string' ? args.newString : undefined}
          patch={typeof data.patch === 'string' ? data.patch : typeof args?.patch === 'string' ? args.patch : undefined}
        />
      </div>
    );
  }
  if (tool === 'code.team.run' && data) return <TeamView result={data} />;
  if (tool === 'fs.readFile' && data) {
    return (
      <div>
        <p className="muted">
          {String(data.bytes ?? '')} 字节 · 第 {String(data.startLine ?? '?')}–{String(data.endLine ?? '?')} 行 / 共 {String(data.totalLines ?? '?')} 行
          {data.truncated === true ? ' · 已截断' : ''}
          {typeof data.sha256 === 'string' ? ` · sha256 ${data.sha256.slice(0, 12)}…` : ''}
        </p>
        {typeof data.content === 'string' && <pre className="exec-code">{data.content.slice(0, 4000)}</pre>}
      </div>
    );
  }
  return <pre className="exec-json">{stringify(result)}</pre>;
}

function StepView(props: { card: StepCard }) {
  const { card } = props;
  /** 影响面 / 多 Agent 方案 / 诊断是「理解结果」，默认展开；其他完成卡先收起。 */
  const important = card.tool === 'code.impact' || card.tool === 'code.team.run' || card.tool === 'code.diagnostics';
  const [open, setOpen] = useState(card.status === 'failed' || card.status === 'waiting' || important);
  const failed = card.status === 'failed';
  useEffect(() => {
    if (failed || card.status === 'waiting') setOpen(true);
  }, [failed, card.status]);

  const headTarget = target(card.tool, card.args);
  const meta = [duration(card.durationMs), statusText(card)].filter(Boolean).join(' · ');
  return (
    <details
      className={`exec-step is-${card.status}`}
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="exec-step-head">
        <span className="exec-step-dot" aria-hidden />
        <b>{toolLabel(card.tool)}</b>
        {headTarget && <code className="exec-step-target">{headTarget}</code>}
        <span className="exec-step-meta">{meta}</span>
      </summary>
      <div className="exec-step-body">
        {card.approval === 'pending' && (
          <p className="exec-note">
            等待确认：第 {String(card.index ?? '?')}/{String(card.total ?? '?')} 步
            {card.risk === 'danger' ? ' · 高危' : card.risk === 'write' ? ' · 写操作' : ' · 只读'}
          </p>
        )}
        {card.approval === 'approved' && <p className="exec-note is-ok">已批准执行</p>}
        {card.approval === 'rejected' && <p className="exec-note is-bad">已拒绝：{card.approvalReason ?? '用户拒绝'}</p>}
        {card.argsPreview && (
          <pre className="exec-args">{card.argsPreview}</pre>
        )}
        {card.args && !card.argsPreview && (
          <details className="exec-subdetails">
            <summary>参数</summary>
            <pre className="exec-args">{stringify(card.args, 4000)}</pre>
          </details>
        )}
        {card.error && <pre className="exec-error">{card.error}</pre>}
        <ResultView card={card} />
      </div>
    </details>
  );
}

export function ExecutionLog(props: { events: AgentEvent[] }) {
  const items = useMemo(() => buildTimeline(props.events), [props.events]);
  const steps = items.filter((item): item is Extract<TimelineItem, { kind: 'step' }> => item.kind === 'step');
  const done = steps.filter(item => item.card.status === 'completed').length;
  const failed = steps.filter(item => item.card.status === 'failed').length;

  // 新步骤出现时跟到尾部；用户自己往上翻时不要抢滚动。
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastCount = useRef(0);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    if (items.length > lastCount.current) element.scrollTop = element.scrollHeight;
    lastCount.current = items.length;
  }, [items.length]);

  return (
    <section className="card log execution-timeline">
      <div className="row">
        <h2>执行过程</h2>
        <span className="muted">
          {steps.length > 0 ? `${String(steps.length)} 步 · 完成 ${String(done)}${failed > 0 ? ` · 失败 ${String(failed)}` : ''}` : `${String(items.length)} 条事件`}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="muted">暂无事件。</p>
      ) : (
        <div className="exec-list" ref={listRef}>
          {items.map(item => item.kind === 'step'
            ? <StepView key={item.key} card={item.card} />
            : item.detail
              ? (
                <details key={item.key} className={`exec-milestone-detail t-${item.tone}`}>
                  <summary>{item.text}</summary>
                  <pre className="exec-code">{item.detail}</pre>
                </details>
              )
              : <div key={item.key} className={`exec-milestone t-${item.tone}`}>{item.text}</div>)}
        </div>
      )}
    </section>
  );
}

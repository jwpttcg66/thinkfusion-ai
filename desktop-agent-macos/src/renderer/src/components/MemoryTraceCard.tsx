import { useEffect, useState } from 'react';
import { describeInjection, type MemoryUsageEvent } from '../../../shared/memory';

/**
 * 对话页 · 本轮记忆注入。
 *
 * 只回答四件事：注给了谁、命中了什么、为什么跳过、三个指纹是否一致。
 * **不写「模型已使用记忆」**——L3 最多证明「适配器拼装并提交给传输层的
 * 载荷含这段内容」，不能证明对端收到，更不能证明模型照着它回答。
 */
export function MemoryTraceCard({
  conversationId,
  refreshKey = 0
}: {
  conversationId: string;
  /**
   * 变化的信号（调用方传消息条数）。只依赖 conversationId 会漏掉「组件先挂载、
   * 之后回答回来才写入 usage」这段——真机验收就是卡片一直不出现。
   */
  refreshKey?: number;
}) {
  const [events, setEvents] = useState<MemoryUsageEvent[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    window.agentAPI.memory
      .listUsage(conversationId)
      .then(next => { if (alive) setEvents(next); })
      .catch(() => { if (alive) setEvents([]); });
    return () => { alive = false; };
  }, [conversationId, refreshKey]);

  if (events.length === 0) return null;

  const injected = events.filter(event => event.status === 'provider-confirmed' || event.status === 'injected').length;
  const skipped = events.filter(event => event.status === 'skipped').length;
  const failed = events.filter(event => event.status.startsWith('failed')).length;

  return (
    <div className="chat-memory-trace">
      <button type="button" className="chat-memory-summary" onClick={() => setOpen(!open)}>
        <span>记忆：注入 {injected} · 跳过 {skipped}{failed > 0 ? ` · 失败 ${failed}` : ''}</span>
        <span className="muted">{open ? '收起' : '展开逐请求明细'}</span>
      </button>
      {open && (
        <div className="chat-memory-body">
          {events.map(event => (
            <div key={event.requestId} className="chat-memory-item">
              <div className="chat-memory-row">
                <span className={`memory-dot ${event.providerConfirmed ? 'ok' : event.status === 'skipped' ? 'skip' : 'warn'}`} />
                <strong>{describeInjection(event)}</strong>
                <span className="muted">{event.injectionPoint}</span>
              </div>
              <div className="chat-memory-row muted">请求 {event.requestId}</div>
              <div className="chat-memory-row muted">
                命中 {event.memoryIds.length} 条 · {event.charCount} 字
                {event.memoryIds.length > 0 ? `：${event.memoryIds.join(', ')}` : ''}
              </div>
              <div className="chat-memory-row muted">
                L1 {short(event.contextHash)} · L2 {short(event.submittedSystemHash)} · L3 {short(event.providerSystemHash)}
              </div>
              {event.skipReason && <div className="chat-memory-row muted">跳过原因：{event.skipReason}</div>}
            </div>
          ))}
          <p className="settings-hint">
            L3 只证明适配器组装并提交了这段内容，不证明模型在推理中采用了它；行为层另做回归记录。
          </p>
        </div>
      )}
    </div>
  );
}

function short(hash: string | undefined): string {
  return hash ? hash.slice(0, 10) : '—';
}

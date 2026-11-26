import React, { useMemo, useState } from 'react';
import {
  buildParallelLanes,
  shouldShowParallelRail,
  type ParallelLane
} from '../../../shared/parallel-lanes';
import type { ChannelStatus, ConversationMessage } from '../../../shared/conversation';
import { MarkdownBody } from './MarkdownBody';

/**
 * D2 并行对话浮层（侧边轨）。
 *
 * 三条边界（V1.1 §2.2）：
 * - 不占主流位置：它挂在滚动区右侧，展开只遮住空白边缘，不插入主流消息；
 * - 独立保存各成员输出与状态：lane 来自 `buildParallelLanes` 的纯投影，
 *   新一轮追加、不清空上一轮；
 * - 中断交互复用 App 的 `cancel()`，不在浮层里另造第二套停止逻辑。
 *
 * 没有真实并行回答就不画（空壳不冒充并行对话）。
 */
function statusLabel(lane: ParallelLane): string {
  if (lane.status === 'streaming') return '输出中';
  if (lane.status === 'failed') return '失败';
  return '已回答';
}

function LaneCard(props: { lane: ParallelLane; onJump: (messageId: string) => void }) {
  const { lane } = props;
  const [open, setOpen] = useState(false);
  const time = new Date(lane.at);
  const timeText = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  return (
    <li className={`parallel-lane is-${lane.status}`}>
      <button
        type="button"
        className="parallel-lane-head"
        onClick={() => {
          if (lane.messageId) props.onJump(lane.messageId);
          else setOpen(value => !value);
        }}
        title={lane.messageId ? '跳到主流中的这条回答' : '展开这条流式回答'}
      >
        <span className="parallel-lane-dot" aria-hidden />
        <b>{lane.label}</b>
        <span className="parallel-lane-status">{statusLabel(lane)}</span>
        <span className="parallel-lane-time">{timeText}</span>
      </button>
      {lane.status === 'streaming' && <span className="spinner" aria-hidden />}
      {lane.text && (
        <details className="parallel-lane-body" open={open || lane.status === 'streaming'}>
          <summary>{lane.text.length} 字</summary>
          <div className="parallel-lane-md"><MarkdownBody text={lane.text} /></div>
        </details>
      )}
      {!lane.text && lane.reasoning && (
        <details className="parallel-lane-body">
          <summary>思考中 · {lane.reasoning.length} 字</summary>
          <pre>{lane.reasoning}</pre>
        </details>
      )}
    </li>
  );
}

export function ParallelConversationRail(props: {
  messages: readonly ConversationMessage[];
  deltas: Readonly<Record<string, { text: string; reasoning: string; done: boolean }>>;
  channelStatuses: readonly ChannelStatus[];
  /** 通道 id → 图标，复用主流那一份，不另建映射。 */
  glyphs: ReadonlyMap<string, string>;
  live: boolean;
  now: number;
  /** 中断复用 App 的取消：停止等待 / 取消任务都走它。 */
  onInterrupt: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const labels = useMemo(
    () => new Map(props.channelStatuses.map(status => [status.id, status.label] as const)),
    [props.channelStatuses]
  );
  const turns = useMemo(
    () => buildParallelLanes({
      messages: props.messages,
      deltas: props.deltas,
      labels,
      live: props.live,
      now: props.now
    }),
    [props.messages, props.deltas, labels, props.live, props.now]
  );
  const show = shouldShowParallelRail(turns);
  if (!show) return null;

  const laneCount = turns.reduce((sum, turn) => sum + turn.lanes.length, 0);
  const jumpTo = (messageId: string) => {
    document.getElementById(`parallel-msg-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <aside
      className={`parallel-rail${expanded ? ' is-expanded' : ''}`}
      aria-label="并行对话"
    >
      <button
        type="button"
        className="parallel-rail-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
      >
        <span className="parallel-rail-glyph" aria-hidden>∥</span>
        <span>并行对话</span>
        <span className="parallel-rail-count">{String(laneCount)}</span>
      </button>
      {expanded && (
        <div className="parallel-rail-panel">
          <header className="parallel-rail-head">
            <b>并行对话</b>
            <button type="button" className="btn ghost" onClick={props.onInterrupt}>
              停止等待
            </button>
          </header>
          <div className="parallel-rail-scroll">
            {turns.map(turn => (
              <section key={turn.key} className="parallel-turn">
                <h4>第 {String(turn.index || 1)} 轮 · {String(turn.lanes.length)} 路</h4>
                {turn.prompt && <p className="parallel-turn-prompt">{turn.prompt}</p>}
                <ul className="parallel-lanes">
                  {turn.lanes.map(lane => <LaneCard key={lane.key} lane={lane} onJump={jumpTo} />)}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

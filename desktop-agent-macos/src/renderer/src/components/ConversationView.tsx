import React, { useEffect, useRef, useState } from 'react';
import {
  normalizeExecutionConfig,
  type ChannelStatus,
  type Conversation,
  type ConversationExecutionConfig,
  type ConversationMessage,
  type Synthesis
} from '../../../shared/conversation';

/**
 * The conversation workspace: what the user reads and replies to.
 *
 * This is deliberately plain. It renders text that came from a chat page, plus
 * one structured block at the end that the app derived itself. Nothing here
 * shows a plan, a JSON block, or a step list — if a conversation ever needs
 * those, it went down the wrong path and the router should be fixed instead of
 * the view.
 */

const INTENT_LABEL: Record<Conversation['intent'], string> = {
  answer: '问答',
  research: '研究',
  compare: '比较',
  extract: '网页提取',
  workspace: '工作区任务'
};

const STATUS_LABEL: Record<Conversation['status'], string> = {
  thinking: '思考中',
  collecting: '收集中',
  comparing: '比较中',
  synthesizing: '综合中',
  answered: '已回答',
  awaiting_user: '等待你补充',
  failed: '失败',
  cancelled: '已取消'
};

/**
 * 这条会话自己用的执行模式。
 *
 * 底栏那行「当前：…」是**下一条提问**的草稿设置，跟正在看的这条会话没
 * 关系：打开一条混合模式的历史会话时，底栏仍写着「网页」，于是「网页模式
 * 怎么有本地模型在回答」看起来像个 bug。模式属于会话，就该出现在会话头部。
 */
const MODE_LABEL: Record<ConversationExecutionConfig['executionMode'], string> = {
  web: '网页主导',
  local: '本地主导',
  cloud: '云端主导',
  hybrid: '混合主导'
};

export function ConversationView(props: {
  conversation: Conversation;
  messages: ConversationMessage[];
  channelStatuses: ChannelStatus[];
  phases: Record<string, { phase: string; detail?: string; at?: number }>;
  busy: boolean;
}) {
  const { conversation, messages } = props;
  const synthesis = [...messages].reverse().find(message => message.synthesis)?.synthesis ?? null;
  /**
   * id -> display name, from the health record the main process already sends.
   * One map, built once per render, used by the strip, the answer cards and the
   * synthesis — so all three say the same name for the same site.
   */
  const labels = new Map(props.channelStatuses.map(status => [status.id, status.label]));
  const askedLabel = conversation.channels.map(id => labels.get(id) ?? id).join('、');
  // 老会话没有这个字段，归一化后就是默认的 web，不会因为缺字段显示成空白。
  const mode = MODE_LABEL[normalizeExecutionConfig(conversation.executionConfig).executionMode];

  // 每一轮问的通道都一样，但「这一轮谁答完了」只属于那一轮。以前这条状态条
  // 只挂在会话头部：第二轮开始后它还留在第一轮的位置，往上滚出去几屏——正在
  // 等谁、谁已经答完，界面上就看不见了。所以按轮次分组，每轮各带一条。
  const turns = groupTurns(messages);
  const liveStatus: ReadonlyArray<Conversation['status']> = ['thinking', 'collecting', 'comparing', 'synthesizing'];

  // 新一轮在转录最下面。不把它带到眼前，「这一轮谁在答」还是得自己往下滚。
  // 只在这一轮刚出现时对齐一次，之后回答流进来时不再动滚动位置——那会把
  // 正在往上读的人拽回来。
  const lastTurnRef = useRef<HTMLElement | null>(null);
  const lastUserId = [...messages].reverse().find(message => message.role === 'user')?.messageId ?? '';
  useEffect(() => {
    if (!lastUserId) return;
    lastTurnRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [lastUserId]);

  return (
    <section className="conversation" aria-label="对话">
      <header className="conversation-head">
        <div className="conversation-title">
          <h2>{conversation.title}</h2>
          <span className={`intent-badge intent-${conversation.intent}`}>{INTENT_LABEL[conversation.intent]}</span>
          <span className={`conv-status s-${conversation.status}`}>{STATUS_LABEL[conversation.status]}</span>
        </div>
        <p className="conversation-why">
          {`这条用「${mode}」模式跑`}
          {' · '}
          路由依据：{conversation.intentReason}
          {/* Who is actually being asked, said out loud. Every channel that is
              switched on is asked — a single answer is not a cross-check — so
              the line names them instead of describing a routing decision that
              no longer exists. */}
          {` · 同时问 ${askedLabel || '所有已开启的通道'}`}
          {conversation.error ? ` · ${conversation.error}` : ''}
        </p>
      </header>

      <div className="conversation-body">
        {messages.length === 0 && <p className="muted">还没有内容。</p>}

        {turns.map((turn, turnIndex) => {
          const answers = turn.blocks.flatMap(block => (block.kind === 'answers' ? block.messages : []));
          const answered = new Set(answers.map(message => message.channelId).filter((id): id is string => !!id));
          // 只有最后一轮、并且这一轮还在跑，才用实时状态：更早的那几轮早就结束了，
          // 它们的「谁答完了」只能从自己的消息里数出来。
          const live = turnIndex === turns.length - 1 && (props.busy || liveStatus.includes(conversation.status));

          return (
            <section
              className="turn"
              key={turn.key}
              ref={turnIndex === turns.length - 1 ? lastTurnRef : undefined}
            >
              {turn.user && (
                <article className="bubble role-user">
                  <div className="bubble-who">你</div>
                  <div className="bubble-text">{turn.user.text}</div>
                </article>
              )}

              {/* 还没开始问的那一轮（刚提交、页面还在开新会话）也先画出这条：
                  这时候通道一个都还没答，状态条本身就是「正在等谁」。 */}
              {turn.user && (
                <ChannelStrip
                  channels={conversation.channels}
                  statuses={props.channelStatuses}
                  phases={live ? props.phases : {}}
                  answered={answered}
                  live={live}
                  labels={labels}
                />
              )}

              {turn.blocks.map(block => {
                if (block.kind === 'answers') return <ChannelGrid key={block.key} messages={block.messages} labels={labels} />;
                if (block.kind === 'synthesis') return <SynthesisCard key={block.key} synthesis={block.message.synthesis!} labels={labels} />;
                return (
                  <p key={block.key} className="conv-system">
                    {block.message.text}
                  </p>
                );
              })}
            </section>
          );
        })}

        {props.busy && (
          <div className="conv-working">
            <span className="dot-pulse" />
            {STATUS_LABEL[conversation.status]}
          </div>
        )}

        {synthesis && !synthesis.degraded && synthesis.disputed.length === 0 && (
          <p className="conv-hint">
            各通道没有互相矛盾，但这不等于结论已经被验证——只说明没人提出反例。
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * 把消息切成「轮」。
 *
 * 一条会话是一串问答：用户那一句开头，后面跟着这一轮的通道回答、系统提示和
 * 综合结果。以前渲染只按消息类型走，所以「这一轮谁答完了」只能靠整条会话的
 * 消息算，第二轮一开始就全是「已回答」。分组之后每轮自带自己的答案集合。
 *
 * 没有用户消息的前导块（老会话、系统提示）单独成一轮，原样显示，不丢内容。
 */
function groupTurns(messages: ConversationMessage[]): Array<{
  key: string;
  user?: ConversationMessage;
  blocks: Array<
    | { kind: 'answers'; key: string; messages: ConversationMessage[] }
    | { kind: 'synthesis'; key: string; message: ConversationMessage }
    | { kind: 'system'; key: string; message: ConversationMessage }
  >;
}> {
  const turns: Array<{
    key: string;
    user?: ConversationMessage;
    blocks: Array<
      | { kind: 'answers'; key: string; messages: ConversationMessage[] }
      | { kind: 'synthesis'; key: string; message: ConversationMessage }
      | { kind: 'system'; key: string; message: ConversationMessage }
    >;
  }> = [];

  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ key: `turn-${message.messageId}`, user: message, blocks: [] });
      continue;
    }
    if (turns.length === 0) turns.push({ key: 'turn-leading', blocks: [] });
    const turn = turns[turns.length - 1];

    if (message.role === 'channel') {
      // 相邻的通道消息是同一轮的答案，合成一张网格——两张卡片才比得出来。
      const last = turn.blocks[turn.blocks.length - 1];
      if (last && last.kind === 'answers') last.messages.push(message);
      else turn.blocks.push({ kind: 'answers', key: `answers-${message.messageId}`, messages: [message] });
      continue;
    }
    if (message.role === 'synthesis' && message.synthesis) {
      turn.blocks.push({ kind: 'synthesis', key: message.messageId, message });
      continue;
    }
    turn.blocks.push({ kind: 'system', key: message.messageId, message });
  }

  return turns;
}

/**
 * A channel's display name, as the main process reports it.
 *
 * Not a hardcoded `if (id === 'deepseek')`. That map was a third place a new
 * site had to be added, and the only one with no compiler behind it — the card
 * would have shown the raw id `claude` next to an answer while every other
 * surface showed "Claude".
 */
function labelOf(channelId: string | undefined, labels: ReadonlyMap<string, string>): string {
  if (!channelId) return '通道';
  return labels.get(channelId) ?? channelId;
}

/**
 * One turn's channel answers, each in its own card.
 *
 * The grid is auto-fitting rather than a fixed two columns: in the app's narrow
 * default pane two 240px cards still fit, and when the pane is dragged wider
 * they stay readable instead of stretching into unreadable lines.
 */
function ChannelGrid({ messages, labels }: { messages: ConversationMessage[]; labels: ReadonlyMap<string, string> }) {
  return (
    <div className="channel-grid">
      {messages.map(message => (
        <article key={message.messageId} className={`channel-card ch-${message.channelId ?? 'unknown'}`}>
          <header className="channel-card-head">
            <span className="channel-dot" />
            <b>{labelOf(message.channelId, labels)}</b>
            <span className="channel-chars">{message.text.length} 字</span>
          </header>
          <div className="channel-card-body">{message.text}</div>
        </article>
      ))}
    </div>
  );
}

function ChannelStrip(props: {
  channels: string[];
  statuses: ChannelStatus[];
  phases: Record<string, { phase: string; detail?: string; at?: number }>;
  answered: Set<string>;
  /** 这一轮还在跑：状态来自实时事件；已经结束的轮次只看消息。 */
  live: boolean;
  labels: ReadonlyMap<string, string>;
}) {
  // A page can take minutes, so "提问中" has to move. Ticking locally rather
  // than streaming an event every second keeps the main process out of it: the
  // only thing that changes is a number the renderer can derive from the phase's
  // own timestamp.
  const [now, setNow] = useState(() => Date.now());
  const asking = Object.values(props.phases).some(item => item.phase === 'asking');

  useEffect(() => {
    if (!asking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [asking]);

  if (props.channels.length === 0) return null;

  return (
    <ul className="channel-strip">
      {props.channels.map(channelId => {
        const status = props.statuses.find(item => item.id === channelId);
        const phase = props.phases[channelId];
        // 结束的那几轮：「有它的消息」就是答了，没有就是没答。用实时阶段会在
        // 历史轮次上显示出上一轮残留的「提问中」，或者干脆全是「已回答」。
        const label = props.live
          ? phase?.phase ?? (props.answered.has(channelId) ? 'answered' : status?.available ? 'idle' : 'unavailable')
          : props.answered.has(channelId)
            ? 'answered'
            : 'no-answer';
        const waited = props.live && phase?.phase === 'asking' && phase.at ? Math.max(0, Math.round((now - phase.at) / 1000)) : 0;
        return (
          <li
            key={channelId}
            className={`channel-chip phase-${label}`}
            title={phase?.detail ?? status?.detail}
          >
            <span className="channel-name">{labelOf(channelId, props.labels)}</span>
            <span className="channel-phase">
              {phaseLabel(label)}
              {waited > 0 && <span className="channel-elapsed"> {formatWaited(waited)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Seconds until a minute, then m:ss — the same shape as a call timer. */
function formatWaited(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'resetting':
      return '开新会话';
    case 'asking':
      return '提问中';
    case 'answered':
      return '已回答';
    case 'failed':
      return '失败';
    case 'busy':
      return '忙，已跳过';
    case 'unavailable':
      return '不可用';
    case 'no-answer':
      return '没有回答';
    default:
      return '待命';
  }
}

/**
 * The structured result. Every section is rendered even when empty, because
 * "no gaps found" and "we could not look for gaps" must not look the same.
 */
function SynthesisCard({ synthesis, labels }: { synthesis: Synthesis; labels: ReadonlyMap<string, string> }) {
  return (
    <article className={`synthesis ${synthesis.degraded ? 'degraded' : ''}`}>
      <div className="synthesis-head">
        <span className="synthesis-mark">◈</span>
        <b>ThinkFusion 综合分析</b>
        {synthesis.degraded && <span className="synthesis-warn">未形成共识，以下是并列结果</span>}
      </div>

      <p className="synthesis-lead">{synthesis.recommendation}</p>

      {synthesis.overlap && synthesis.overlap.length > 0 && (
        <p className="synthesis-overlap">
          <span className="synthesis-overlap-label">共同提到</span>
          {synthesis.overlap.map(item => (
            <span key={item} className="synthesis-term">
              {item}
            </span>
          ))}
        </p>
      )}

      {synthesis.disputed.length > 0 && (
        <div className="synthesis-block">
          <h4>分歧（{synthesis.disputed.length}）</h4>
          {synthesis.disputed.map((dispute, index) => (
            <div key={index} className="dispute">
              <p className="dispute-topic">{dispute.topic}</p>
              <p className="dispute-pivot">分歧点：{dispute.pivot}</p>
              <ul>
                {dispute.positions.map((position, positionIndex) => (
                  <li key={positionIndex}>
                    <span className="who">{labelOf(position.channelId, labels)}</span>
                    {position.stance}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {synthesis.consensus.length > 0 && (
        <div className="synthesis-block">
          <h4>共识（{synthesis.consensus.length}）</h4>
          <ul>
            {synthesis.consensus.map((claim, index) => (
              <li key={index}>
                {claim.text}
                <span className="claim-src">
                  {claim.sources.map(source => labelOf(source.channelId, labels)).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}
                </span>
                {/* Without the figures the claim cannot be checked, and "why do
                    these two agree" becomes a matter of trust. */}
                {claim.evidence.length > 0 && <span className="claim-evidence">{claim.evidence.join(' · ')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.gaps.length > 0 && (
        <div className="synthesis-block">
          <h4>覆盖缺口（{synthesis.gaps.length}）</h4>
          <ul>
            {synthesis.gaps.map((gap, index) => (
              <li key={index}>
                <b>{gap.topic}</b>
                <span className="muted"> — {gap.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.unique.length > 0 && (
        <details className="synthesis-block">
          <summary>只有一个通道提到的（{synthesis.unique.length}）</summary>
          <ul>
            {synthesis.unique.map((claim, index) => (
              <li key={index}>
                {claim.text}
                <span className="claim-src">{labelOf(claim.sources[0]?.channelId, labels)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {synthesis.fusion && (
        <footer className="synthesis-meta">
          <span>结论来源：{BACKEND_LABEL[synthesis.fusion.backend]}</span>
          {synthesis.fusion.leadAgentId && (
            <span>
              主导：{labelOf(synthesis.fusion.leadAgentId, labels)}
              {synthesis.fusion.leadAuto
                ? `（系统自动选择${synthesis.fusion.leadReason ? `：${synthesis.fusion.leadReason}` : ''}）`
                : '（手动指定）'}
            </span>
          )}
        </footer>
      )}
    </article>
  );
}

/** 综合卡页脚用：结论由谁算的，界面上必须能一眼分清。 */
const BACKEND_LABEL: Record<NonNullable<Synthesis['fusion']>['backend'], string> = {
  local: '本地规则（按句子比对，不联网）',
  'local-model': '本地模型（读完各家回答后归纳）',
  remote: '远程模型 API',
  web: '网页模型主导（读完全部回答后评判）'
};

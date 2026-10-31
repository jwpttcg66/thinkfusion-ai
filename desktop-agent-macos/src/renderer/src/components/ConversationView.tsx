import React from 'react';
import type { ChannelStatus, Conversation, ConversationMessage, Synthesis } from '../../../shared/conversation';

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

export function ConversationView(props: {
  conversation: Conversation;
  messages: ConversationMessage[];
  channelStatuses: ChannelStatus[];
  phases: Record<string, { phase: string; detail?: string }>;
  busy: boolean;
}) {
  const { conversation, messages } = props;
  const synthesis = [...messages].reverse().find(message => message.synthesis)?.synthesis ?? null;
  /**
   * Which channels have answered, derived from the messages rather than from
   * live events. Opening a conversation from the history list replays no
   * events, so the chips used to read 待命 for a channel whose answer was on
   * screen right below them.
   */
  const answeredChannels = new Set(
    messages.filter(message => message.role === 'channel' && message.channelId).map(message => message.channelId as string)
  );

  return (
    <section className="conversation" aria-label="对话">
      <header className="conversation-head">
        <div className="conversation-title">
          <h2>{conversation.title}</h2>
          <span className={`intent-badge intent-${conversation.intent}`}>{INTENT_LABEL[conversation.intent]}</span>
          <span className={`conv-status s-${conversation.status}`}>{STATUS_LABEL[conversation.status]}</span>
        </div>
        <p className="conversation-why">
          路由依据：{conversation.intentReason}
          {conversation.error ? ` · ${conversation.error}` : ''}
        </p>
        <ChannelStrip
          channels={conversation.channels}
          statuses={props.channelStatuses}
          phases={props.phases}
          answered={answeredChannels}
        />
      </header>

      <div className="conversation-body">
        {messages.length === 0 && <p className="muted">还没有内容。</p>}

        {messages.map((message, index) => {
          if (message.role === 'synthesis' && message.synthesis) {
            return <SynthesisCard key={message.messageId} synthesis={message.synthesis} />;
          }
          if (message.role === 'system') {
            return (
              <p key={message.messageId} className="conv-system">
                {message.text}
              </p>
            );
          }
          if (message.role === 'channel') {
            // Consecutive channel messages are one turn's answers. They are
            // rendered together, in their own cards, because comparing two
            // answers is the point — and two paragraphs of prose stacked in one
            // column cannot be compared, only read in order.
            if (index > 0 && messages[index - 1].role === 'channel') return null;
            const group: ConversationMessage[] = [];
            for (let cursor = index; cursor < messages.length && messages[cursor].role === 'channel'; cursor += 1) {
              group.push(messages[cursor]);
            }
            return <ChannelGrid key={message.messageId} messages={group} />;
          }
          return (
            <article key={message.messageId} className={`bubble role-${message.role}`}>
              <div className="bubble-who">你</div>
              <div className="bubble-text">{message.text}</div>
            </article>
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

function labelOf(channelId?: string): string {
  if (channelId === 'deepseek') return 'DeepSeek';
  if (channelId === 'chatgpt') return 'ChatGPT';
  return channelId ?? '通道';
}

/**
 * One turn's channel answers, each in its own card.
 *
 * The grid is auto-fitting rather than a fixed two columns: in the app's narrow
 * default pane two 240px cards still fit, and when the pane is dragged wider
 * they stay readable instead of stretching into unreadable lines.
 */
function ChannelGrid({ messages }: { messages: ConversationMessage[] }) {
  return (
    <div className="channel-grid">
      {messages.map(message => (
        <article key={message.messageId} className={`channel-card ch-${message.channelId ?? 'unknown'}`}>
          <header className="channel-card-head">
            <span className="channel-dot" />
            <b>{labelOf(message.channelId)}</b>
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
  phases: Record<string, { phase: string; detail?: string }>;
  answered: Set<string>;
}) {
  if (props.channels.length === 0) return null;

  return (
    <ul className="channel-strip">
      {props.channels.map(channelId => {
        const status = props.statuses.find(item => item.id === channelId);
        const phase = props.phases[channelId];
        const label = phase?.phase ?? (props.answered.has(channelId) ? 'answered' : status?.available ? 'idle' : 'unavailable');
        return (
          <li key={channelId} className={`channel-chip phase-${label}`} title={phase?.detail ?? status?.detail}>
            <span className="channel-name">{labelOf(channelId)}</span>
            <span className="channel-phase">{phaseLabel(label)}</span>
          </li>
        );
      })}
    </ul>
  );
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
    default:
      return '待命';
  }
}

/**
 * The structured result. Every section is rendered even when empty, because
 * "no gaps found" and "we could not look for gaps" must not look the same.
 */
function SynthesisCard({ synthesis }: { synthesis: Synthesis }) {
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
                    <span className="who">{labelOf(position.channelId)}</span>
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
                  {claim.sources.map(source => labelOf(source.channelId)).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}
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
                <span className="claim-src">{labelOf(claim.sources[0]?.channelId)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

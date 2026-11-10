import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  normalizeExecutionConfig,
  type ChannelStatus,
  type Conversation,
  type ConversationExecutionConfig,
  type ConversationMessage,
  type Synthesis
} from '../../../shared/conversation';
import { splitSummarySections } from '../../../shared/text';
import type { DebateView } from '../../../shared/contracts';
import { routingLabel, workspaceLabel } from '../../../shared/workspace';
import { MarkdownBody } from './MarkdownBody';

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

/** Model Router 收敛后的模式名，和设置面板里的四档说法保持一致。 */
function modeLabelOf(mode: 'web' | 'local' | 'cloud' | 'hybrid'): string {
  if (mode === 'web') return '网页主导';
  if (mode === 'local') return '本地主导';
  if (mode === 'cloud') return '云端主导';
  return '混合主导';
}

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

/** 导出结果里那句「12.4 KB」，比一串字节数好读。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
  /** 通道 id → 站点图标（K / G / ✦），综合里的「观点A」要配上它。 */
  glyphs: ReadonlyMap<string, string>;
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

  // 新一轮在转录最下面。不把它带到眼前，「这一轮谁在答」还是得自己往下滚。  // 只在这一轮刚出现时对齐一次，之后回答流进来时不再动滚动位置——那会把
  // 正在往上读的人拽回来。
  /**
   * 导出：两种格式同一份内容，只是排版不同。
   *
   * 这里只负责叫主进程写文件——正文和排版都在主进程里完成（它自己读存的
   * 消息）。界面不把正文抄出来再传一遍，那样导出的东西就有可能和存的对不上。
   */
  const [exporting, setExporting] = useState<'md' | 'docx' | null>(null);
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleExport(format: 'md' | 'docx') {
    if (exporting) return;
    setExporting(format);
    setExportNote(null);
    try {
      const result = await window.agentAPI.exportConversation({
        conversationId: conversation.conversationId,
        format
      });
      setExportNote(
        result
          ? { ok: true, text: `已保存：${result.path}（${formatBytes(result.bytes)}，${result.turns} 轮）` }
          : { ok: true, text: '已取消保存' }
      );
    } catch (error) {
      setExportNote({
        ok: false,
        text: `导出失败：${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setExporting(null);
    }
  }

  const rootRef = useRef<HTMLElement | null>(null);
  const lastTurnRef = useRef<HTMLElement | null>(null);
  const lastUserId = [...messages].reverse().find(message => message.role === 'user')?.messageId ?? '';

  /**
   * 打开一条会话时直接停在最底下，而不是从第一条开始往下拉。
   *
   * 原来用的是「把最后一轮顶到视口顶部」：老会话有十几轮，内容要比视口高得多，
   * 顶上去看到的还是中间那段，而且平滑动画是从头往下滑过去的——点开一条几天前
   * 的会话，先看到的是几天前那一问。打开会话要看的是「说到哪儿了」，所以这里
   * 直接落到底、不做动画。
   *
   * 等一会儿再停手，是因为消息和会话不是同一次渲染到的：先切会话，消息随后
   * 才塞进来；只在切会话那一刻落底，落的是上一屏的高度。
   */
  const [settling, setSettling] = useState(true);  useEffect(() => {
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 1200);
    return () => clearTimeout(timer);
  }, [conversation.conversationId]);

  const scrolledUser = useRef('');
  useLayoutEffect(() => {
    if (!settling) return;
    const container = rootRef.current?.closest('.scroll') as HTMLElement | null;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    // 这一句已经在眼前了，settling 结束以后不要再用平滑滚动把它拽一次。
    scrolledUser.current = lastUserId;
  }, [settling, messages, lastUserId]);

  useEffect(() => {
    if (!lastUserId || settling) return;
    if (scrolledUser.current === lastUserId) return;
    scrolledUser.current = lastUserId;
    lastTurnRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [lastUserId, settling]);

  return (
    <section className="conversation" aria-label="对话" ref={rootRef}>
      <header className="conversation-head">
        <div className="conversation-top">
          <div className="conversation-title">
            <h2>{conversation.title}</h2>
            <span className={`intent-badge intent-${conversation.intent}`}>{INTENT_LABEL[conversation.intent]}</span>
            {conversation.workspaceMode === 'engineering' && (
              <span className="intent-badge workspace-badge" title={conversation.workspaceRoot ?? ''}>
                {workspaceLabel('engineering')}
                {conversation.routing ? ` · ${routingLabel(conversation.routing)}` : ''}
              </span>
            )}
            <span className={`conv-status s-${conversation.status}`}>{STATUS_LABEL[conversation.status]}</span>
          </div>
          {/* 导出：内容来自主进程存的这条会话，排版由导出模板定，不经过模型。
              默认存 Markdown；Word 要单独点，因为那是一条「排好版的文档」分支，
              不点就不会生成。 */}
          <div className="export-bar">
            <button
              type="button"
              className="export-btn"
              disabled={exporting !== null}
              onClick={() => void handleExport('md')}
              title="存成 Markdown（默认格式，纯文本，可 diff）"
            >
              {exporting === 'md' ? '导出中…' : '导出'}
            </button>
            <button
              type="button"
              className="export-btn is-ghost"
              disabled={exporting !== null}
              onClick={() => void handleExport('docx')}
              title="单独指定才生成 Word 文档（版式由模板定）"
            >
              {exporting === 'docx' ? '生成中…' : 'Word'}
            </button>
          </div>
        </div>
        {exportNote && (
          <p className={`export-note ${exportNote.ok ? '' : 'is-error'}`}>
            {exportNote.ok ? '' : '⚠ '}
            {exportNote.text}
          </p>
        )}
        <p className="conversation-why">
          {`这条用「${mode}」模式跑`}
          {' · '}
          路由依据：{conversation.intentReason}
          {/* Who is actually being asked, said out loud. Every channel that is
              switched on is asked — a single answer is not a cross-check — so
              the line names them instead of describing a routing decision that
              no longer exists. */}
          {` · 同时问 ${askedLabel || '所有已开启的通道'}`}
          {/* V2.1 Model Router：这一轮原本打算用哪些模型、为什么。和上面
              「同时问」分开写，因为一个是事实（问了谁），一个是决定。 */}
          {conversation.modelRoute && (
            <>
              {` · 路由：${conversation.modelRoute.answerers.length} 个回答者 / ${modeLabelOf(conversation.modelRoute.mode)}`}
              {conversation.modelRoute.degraded ? `（${conversation.modelRoute.degraded}）` : ''}
            </>
          )}
          {conversation.error ? ` · ${conversation.error}` : ''}
        </p>
      </header>

      <div className="conversation-body">
        {/* V2.1 工程证据卡：路径、行号、指纹都是本机真实读盘的结果。
            放在最上面，读者能先核对「这轮到底看了哪些文件」，再读模型结论。 */}
        {conversation.engineeringEvidence && conversation.engineeringEvidence.length > 0 && (
          <section className="evidence-card" aria-label="工程证据">
            <div className="evidence-head">
              工程证据 · 实际读取 {conversation.engineeringEvidence.length} 个文件片段
            </div>
            <ul className="evidence-list">
              {conversation.engineeringEvidence.map(item => (
                <li key={`${item.path}:${item.line}:${item.sha256}`}>
                  <span className="evidence-path">{item.path}:{item.line}</span>
                  <span className="evidence-why">{item.why} · sha256 {item.sha256.slice(0, 12)}</span>
                  <pre className="evidence-excerpt">{item.excerpt}</pre>
                </li>
              ))}
            </ul>
          </section>
        )}
        {/* V2.1 网页证据卡：抓回来的正文，不是「回答里提到过一个链接」。
            extract 以前只是给通道贴标签，用户并不知道正文到底有没有取到；
            这里把标题、字数、状态码、抓取时间和指纹摆出来，能核对再读结论。 */}
        {conversation.pageEvidence && (
          <section className="evidence-card" aria-label="网页正文证据">
            <div className="evidence-head">
              网页正文 · {conversation.pageEvidence.title}（{conversation.pageEvidence.chars} 字）
            </div>
            <ul className="evidence-list">
              <li>
                <span className="evidence-path">{conversation.pageEvidence.url}</span>
                <span className="evidence-why">
                  HTTP {conversation.pageEvidence.status} · 抓取于{' '}
                  {new Date(conversation.pageEvidence.fetchedAt).toLocaleString('zh-CN')} · sha256{' '}
                  {conversation.pageEvidence.sha256.slice(0, 12)}
                  {conversation.pageEvidence.notes.length > 0
                    ? ` · ${conversation.pageEvidence.notes.join('；')}`
                    : ''}
                </span>
                <pre className="evidence-excerpt">
                  {conversation.pageEvidence.text.slice(0, 400)}
                  {conversation.pageEvidence.text.length > 400 ? '…' : ''}
                </pre>
              </li>
            </ul>
          </section>
        )}
        {messages.length === 0 && <p className="muted">还没有内容。</p>}

        {turns.map((turn, turnIndex) => {
          const answers = turn.blocks.flatMap(block => (block.kind === 'answers' ? block.messages : []));
          const answeredIds = answers.map(message => message.channelId).filter((id): id is string => !!id);
          const answered = new Set(answeredIds);
          // 只有最后一轮、并且这一轮还在跑，才用实时状态：更早的那几轮早就结束了，
          // 它们的「谁答完了」只能从自己的消息里数出来。
          const live = turnIndex === turns.length - 1 && (props.busy || liveStatus.includes(conversation.status));
          // 提问条按轮看：进行中的一轮用 runner 这一轮的 `channels`；已经结束的
          // 轮次只认本轮消息里出现过的通道——否则上一轮问过、这一轮关掉的模型
          // 还会挂在条上，看起来像「保存后还在问」。
          const stripChannels = live ? conversation.channels : answeredIds;
          const opinionTags = tagsForTurn(stripChannels, answered, labels, props.glyphs);

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
                  channels={stripChannels}
                  statuses={props.channelStatuses}
                  phases={live ? props.phases : {}}
                  answered={answered}
                  live={live}
                  labels={labels}
                />
              )}

              {turn.blocks.map(block => {
                if (block.kind === 'answers') return <ChannelGrid key={block.key} messages={block.messages} labels={labels} />;
                if (block.kind === 'synthesis') {
                  return (
                    <SynthesisCard
                      key={block.key}
                      synthesis={block.message.synthesis!}
                      labels={labels}
                      opinionTags={opinionTags}
                    />
                  );
                }
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

        {/* 这句是规则版综合的读法（「句子没对上」）。主导人读过全文，它自己在
            【分歧】里说了有没有矛盾，这里再说一遍就成了第三套说法。 */}
        {synthesis && !(synthesis.leadSummary ?? synthesis.fusion?.leadAgentId) && !synthesis.degraded && synthesis.disputed.length === 0 && (
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
 * 一条通道的显示名，as the main process reports it.
 *
 * Not a hardcoded `if (id === 'deepseek')`. That map was a third place a new
 * site had to be added, and the only one with no compiler behind it — the card
 * would have shown the raw id `claude` next to an answer while every other
 * surface showed "Claude".
 */
function labelOf(channelId: string | undefined, labels: ReadonlyMap<string, string>): string {
  if (!channelId) return '通道';
  const known = labels.get(channelId);
  if (known) return known;
  // 本地/云端成员的 id 形如 `ollama:deepseek-r1:14b`，不在网页通道的状态表里。
  // 直接显示整串等于把内部 id 摊给用户，去掉提供方前缀后至少是模型名。
  const parts = channelId.split(':');
  return parts.length > 1 && parts[0].length > 0 ? parts.slice(1).join(':') : channelId;
}

/** 「观点A/B/C」和具体是谁的对应关系，一条一枚。 */
interface OpinionTag {
  tag: string;
  letter: string;
  channelId: string;
  label: string;
  glyph: string;
}

/**
 * 这一轮里，「观点A」是谁。
 *
 * 标签按**提问顺序**发，和主进程递给主导人的顺序是同一个：参与通道的顺序
 * 就是 `conversation.channels`，答过的那几家按它排列。所以界面上 A、B、C
 * 永远指向同一家，不随回答到达的先后漂移——三家同时答完时（很常见）它们的
 * 消息顺序本来就是乱的。
 */
function tagsForTurn(
  channels: string[],
  answered: ReadonlySet<string>,
  labels: ReadonlyMap<string, string>,
  glyphs: ReadonlyMap<string, string>
): OpinionTag[] {
  return channels
    .filter(id => answered.has(id))
    .slice(0, 6)
    .map((channelId, index) => {
      const letter = String.fromCharCode(65 + index);
      const label = labelOf(channelId, labels);
      return {
        tag: `观点${letter}`,
        letter,
        channelId,
        label,
        glyph: glyphs.get(channelId) ?? label.slice(0, 1)
      };
    });
}

/**
 * 把结论正文里的「观点A」画成一枚带站点图标的标签。
 *
 * 主导人写的是「观点A」三个字，读者得自己回头找 A 是哪一家。图标补上这一步：
 * 同一个字母永远配同一个图标，扫一眼就知道说的是哪个网页。
 */
function SourceRefText({ text, tags }: { text: string; tags: OpinionTag[] }) {
  const byLetter = new Map(tags.map(item => [item.letter, item]));
  const parts = text.split(/(观点\s*[A-Za-z])/g);
  return (
    <>
      {parts.map((part, index) => {
        const match = part.match(/^观点\s*([A-Za-z])$/);
        const tag = match ? byLetter.get(match[1].toUpperCase()) : undefined;
        if (!tag) return <React.Fragment key={index}>{part}</React.Fragment>;
        return <OpinionChip key={index} tag={tag} />;
      })}
    </>
  );
}

function OpinionChip({ tag }: { tag: OpinionTag }) {
  return (
    <span className="opinion-tag" title={tag.label}>
      <span className="opinion-glyph" aria-hidden="true">{tag.glyph}</span>
      {tag.tag}
    </span>
  );
}

/** 结构化段落里引用某一家时用同一枚标签，读起来和正文是一套。 */
function tagOfChannel(tags: OpinionTag[], channelId: string | undefined): OpinionTag | undefined {
  if (!channelId) return undefined;
  return tags.find(item => item.channelId === channelId);
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
          <div className="channel-card-body">
            <MarkdownBody text={message.text} />
          </div>
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
function SynthesisCard({
  synthesis,
  labels,
  opinionTags
}: {
  synthesis: Synthesis;
  labels: ReadonlyMap<string, string>;
  opinionTags: OpinionTag[];
}) {
  /**
   * 这张卡里只有一套结论。
   *
   * `recommendation` 是主导人写的五段汇总时（runner 会记下 leadAgentId），
   * 【一致】【分歧】【存疑】都在那段话里；规则引擎按句子比对算出来的
   * 「共同提到 / 分歧 / 覆盖缺口 / 只有一个通道提到的」是另一份判断，而且更弱。
   * 两者一起显示时，同一张卡上会出现「没有实质性结论冲突」和「分歧（3）」并存，
   * 那三条还是拿同一家的半截话凑的。所以有主导人汇总时只显示它，规则版留给
   * 主导人没成的那一轮。
   */
  const led = Boolean(synthesis.leadSummary ?? synthesis.fusion?.leadAgentId);
  const sections = led ? splitSummarySections(synthesis.recommendation) : [];
  const structured = !led;

  return (
    <article className={`synthesis ${structured && synthesis.degraded ? 'degraded' : ''}`}>
      <div className="synthesis-head">
        <span className="synthesis-mark">◈</span>
        <b>ThinkFusion 综合分析</b>
        {structured && synthesis.degraded && <span className="synthesis-warn">未形成共识，以下是并列结果</span>}
      </div>

      {sections.length > 0 ? (
        <div className="summary-sections">
          {sections.map((section, index) => (
            <section
              key={index}
              className={`summary-section${section.title === '分歧' ? ' is-dispute' : ''}${section.title ? '' : ' no-title'}`}
            >
              {section.title && <h4 className="summary-section-title">{section.title}</h4>}
              <p className="summary-section-body">
                <SourceRefText text={section.body || '没有'} tags={opinionTags} />
              </p>
            </section>
          ))}
        </div>
      ) : (
        <p className="synthesis-lead">
          <SourceRefText text={synthesis.recommendation} tags={opinionTags} />
        </p>
      )}

      {synthesis.fusion?.debateId && <DebateVerdictStrip debateId={synthesis.fusion.debateId} labels={labels} />}

      {/* 辩后意见单独一块：它回答的是「辩完到底信哪个」，和上面那段辩前
          汇总不是同一件东西。以前它被当成唯一结论，五段汇总因此整段消失。 */}
      {synthesis.finalOpinion && (
        <div className="synthesis-block synthesis-final">
          <h4>辩后最终意见</h4>
          <p className="synthesis-final-body">
            <SourceRefText text={synthesis.finalOpinion} tags={opinionTags} />
          </p>
        </div>
      )}

      {structured && synthesis.overlap && synthesis.overlap.length > 0 && (
        <p className="synthesis-overlap">
          <span className="synthesis-overlap-label">共同提到</span>
          {synthesis.overlap.map(item => (
            <span key={item} className="synthesis-term">
              {item}
            </span>
          ))}
        </p>
      )}

      {structured && synthesis.disputed.length > 0 && (
        <div className="synthesis-block">
          <h4>分歧（{synthesis.disputed.length}）</h4>
          {synthesis.disputed.map((dispute, index) => (
            <div key={index} className="dispute">
              <p className="dispute-topic">{dispute.topic}</p>
              <p className="dispute-pivot">分歧点：{dispute.pivot}</p>
              <ul>
                {dispute.positions.map((position, positionIndex) => (
                  <li key={positionIndex}>
                    <span className="who">
                      {tagOfChannel(opinionTags, position.channelId)
                        ? <OpinionChip tag={tagOfChannel(opinionTags, position.channelId)!} />
                        : labelOf(position.channelId, labels)}
                    </span>
                    {position.stance}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {structured && synthesis.consensus.length > 0 && (
        <div className="synthesis-block">
          <h4>共识（{synthesis.consensus.length}）</h4>
          <ul>
            {synthesis.consensus.map((claim, index) => (
              <li key={index}>
                {claim.text}
                <span className="claim-src">
                  {claim.sources
                    .map(source => tagOfChannel(opinionTags, source.channelId)?.tag ?? labelOf(source.channelId, labels))
                    .filter((value, i, all) => all.indexOf(value) === i)
                    .join(' / ')}
                </span>
                {/* Without the figures the claim cannot be checked, and "why do
                    these two agree" becomes a matter of trust. */}
                {claim.evidence.length > 0 && <span className="claim-evidence">{claim.evidence.join(' · ')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {structured && synthesis.gaps.length > 0 && (
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

      {structured && synthesis.unique.length > 0 && (
        <details className="synthesis-block">
          <summary>只有一个通道提到的（{synthesis.unique.length}）</summary>
          <ul>
            {synthesis.unique.map((claim, index) => (
              <li key={index}>
                {claim.text}
                <span className="claim-src">
                  {tagOfChannel(opinionTags, claim.sources[0]?.channelId)?.tag ?? labelOf(claim.sources[0]?.channelId, labels)}
                </span>
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

/**
 * 这一轮辩论的五档结论（Phase 4 的「结果展示」）。
 *
 * 只显示**能复核**的东西：结论档位、三维各自的判断、可追溯率与少数派。
 * 完整的证据链与修订记录在「研究设置 → 辩论」里，这里不把整份报告塞进
 * 对话流——对话要能读，不是要能查。
 *
 * 读不到辩论（记录被删、文件损坏）就整块不显示：综合卡本身仍然成立，
 * 不该为了一个附加块让整轮回答看起来失败了。
 */
function DebateVerdictStrip({
  debateId,
  labels
}: {
  debateId: string;
  labels: ReadonlyMap<string, string>;
}) {
  const [debate, setDebate] = useState<DebateView | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await window.agentAPI.getDebate(debateId);
        if (alive) setDebate(next);
      } catch {
        if (alive) setDebate(null);
      }
    })();
    return () => { alive = false; };
  }, [debateId]);

  if (!debate?.verdict) return null;
  const verdict = debate.verdict;
  const metrics = debate.metrics;

  return (
    <div className="conversation-verdict">
      <div className={`verdict-banner verdict-${verdict.verdict}`}>
        <b>{VERDICT_LABEL[verdict.verdict] ?? verdict.verdict} · 辩后裁判</b>
        <span>{verdict.conclusion ?? '没有可判定的结论'}</span>
        {verdict.minorityWins && <span>少数派胜出：{verdict.minorityReason ?? '它的证据比多数派更强'}</span>}
      </div>
      <div className="verdict-dimensions">
        {verdict.dimensions.map(dimension => (
          <div key={dimension.dimension} className="verdict-dimension">
            <b>{DIMENSION_LABEL[dimension.dimension] ?? dimension.dimension} · {dimension.outcome}</b>
            <span>{dimension.rationale}</span>
          </div>
        ))}
      </div>
      {metrics && (
        <p className="muted">
          证据可追溯 {metrics.traceability.rate === null ? '无法计算' : `${Math.round(metrics.traceability.rate * 100)}%`}
          （{metrics.traceability.traceable}/{metrics.traceability.judged} 条主张有页面来源）
          {' · '}无效轮次 {metrics.invalidRounds.invalid}/{metrics.invalidRounds.total}
          {' · '}{metrics.rounds} 轮 / {Math.round(metrics.latency.totalMs / 1000)} 秒
        </p>
      )}

      {/* 交锋过程本身也要能看。以前只有一句「辩论跑了 3 轮（completed）」，
          谁质疑了谁、质疑成立不成立，全在没有入口的记录文件里。默认收起，
          想看的人展开，不想看的人不被几万字挡住。 */}
      {debate.rounds.length > 0 && (
        <details className="debate-transcript">
          <summary>
            辩论过程（{debate.rounds.length} 轮 ·{' '}
            {debate.rounds.reduce((total, round) => total + round.messages.length, 0)} 次发言）
          </summary>
          {debate.rounds.map(round => (
            <section key={round.index} className="debate-round">
              <h5>
                第 {round.index + 1} 轮
                {round.converged ? ' · 已收敛' : ''}
              </h5>
              {round.messages.map(message => (
                <article key={message.messageId} className="debate-message">
                  <div className="debate-message-who">
                    {labelOf(message.agentId, labels)} · {KIND_LABEL[message.kind] ?? message.kind}
                  </div>
                  <p>{message.text}</p>
                </article>
              ))}
              {round.failures.map(failure => (
                <p key={failure.agentId} className="debate-failure">
                  {labelOf(failure.agentId, labels)} 没有发言：{failure.detail}
                </p>
              ))}
            </section>
          ))}
        </details>
      )}
    </div>
  );
}

/** 交锋里每种发言的读法。原样显示 `position` 只会让人以为界面没做完。 */
const KIND_LABEL: Record<string, string> = {
  position: '立论',
  question: '质疑',
  rebuttal: '回应',
  revision: '修正'
};

const VERDICT_LABEL: Record<string, string> = {
  supported: '有证据支持',
  partially_supported: '部分支持',
  unsupported: '不成立',
  contradicted: '被反证推翻',
  insufficient_evidence: '证据不足（不等于错）'
};

const DIMENSION_LABEL: Record<string, string> = {
  logic: '逻辑',
  evidence: '证据',
  counterexample: '反例'
};

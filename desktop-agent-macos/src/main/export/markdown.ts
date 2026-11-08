/**
 * 会话 → Markdown。
 *
 * 这里是「导出」这一功能的内容侧，全部由本机数据拼出来，不调用任何模型：
 * 标题、模式、通道名、每一轮的问答、综合结论、工程证据，都是应用已经存下来
 * 的东西。模型写的字原样搬运，一个字都不改——导出不是第二次总结。
 *
 * 产出同时充当 docx 的输入：Word 那一步只负责排版，不再判断内容。
 */

import type { Conversation, ConversationMessage, Synthesis } from '../../shared/conversation';
import { EXECUTION_MODE_LABELS, formatStamp } from '../../shared/export';
import { routingLabel, workspaceLabel } from '../../shared/workspace';

export interface MarkdownInput {
  conversation: Conversation;
  messages: ConversationMessage[];
  /** 通道 id → 显示名。缺的按 id 兜底（`ollama:x` → `x`）。 */
  labels?: Record<string, string>;
  includeEvidence?: boolean;
  /** 导出时刻。测试要固定它，运行时不传。 */
  now?: number;
}

interface Round {
  user?: ConversationMessage;
  blocks: ConversationMessage[];
}

/** 单元格里的 `|` 会把表格截断，换行会把一行拆成两行。 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function labelOf(id: string | undefined, labels: Record<string, string>): string {
  if (!id) return '未知通道';
  const hit = labels[id];
  if (hit) return hit;
  // `ollama:deepseek-r1:14b` / `openai:gpt-4o`：前缀是服务，名字在后半截。
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(colon + 1) : id;
}

function quote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`.trimEnd())
    .join('\n');
}

/**
 * 过程记录只留开头一段。
 *
 * 工程空间的第一条系统消息会把「扫描到哪些目录、取了哪 8 个片段、哪些文件超限」
 * 全写出来，几百字里有一大半是跟这次导出无关的目录清单。原样搬进文档，
 * 读者翻到第三页还在读 Downloads 目录里有哪些 dmg。截断并说明「后面还有多少
 * 字、完整内容在应用里」，比删掉或全塞进去都更接近「如实但不啰嗦」。
 */
const SYSTEM_CLIP = 900;

function clipSystem(text: string): string {
  if (text.length <= SYSTEM_CLIP) return text;
  return `${text.slice(0, SYSTEM_CLIP)}\n…（还有 ${text.length - SYSTEM_CLIP} 字，完整内容见应用内这条会话）`;
}

function rounds(messages: ConversationMessage[]): Round[] {
  const out: Round[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ user: message, blocks: [] });
      continue;
    }
    if (out.length === 0) out.push({ blocks: [] });
    out[out.length - 1].blocks.push(message);
  }
  return out;
}

function synthesisBody(synthesis: Synthesis): string[] {
  const lines: string[] = [];
  // 主导人写过的轮次只剩这一段，其余几组已经被清空；照搬即可，不另加标题。
  if (!synthesis.leadSummary && !synthesis.fusion?.leadAgentId) {
    if (synthesis.consensus.length > 0) {
      lines.push('**一致**', '');
      for (const claim of synthesis.consensus) {
        lines.push(`- ${claim.text}`);
      }
      lines.push('');
    }
    if (synthesis.disputed.length > 0) {
      lines.push('**分歧**', '');
      for (const dispute of synthesis.disputed) {
        lines.push(`- ${dispute.topic}：${dispute.pivot}`);
        for (const position of dispute.positions) {
          lines.push(`  - ${position.stance}`);
        }
      }
      lines.push('');
    }
    if (synthesis.unique.length > 0) {
      lines.push('**只有一家提到**', '');
      for (const claim of synthesis.unique) {
        lines.push(`- ${claim.text}`);
      }
      lines.push('');
    }
    if (synthesis.gaps.length > 0) {
      lines.push('**没答上的地方**', '');
      for (const gap of synthesis.gaps) {
        lines.push(`- ${gap.topic}${gap.why ? `：${gap.why}` : ''}`);
      }
      lines.push('');
    }
  }
  if (synthesis.finalOpinion) {
    lines.push('**最终意见**', '', synthesis.finalOpinion, '');
  }
  return lines;
}

function evidenceSection(conversation: Conversation): string[] {
  const evidence = conversation.engineeringEvidence ?? [];
  const lines: string[] = [];
  if (evidence.length > 0) {
    lines.push('## 附录 A　本机读取的工程证据', '');
    lines.push('这一轮实际读到的是这些片段，路径、行号、指纹都来自本机读盘。', '');
    lines.push('| 文件 | 行 | 为什么读它 | sha256 |', '| --- | --- | --- | --- |');
    for (const item of evidence) {
      const size =
        item.totalLines != null
          ? `全文 ${item.totalLines} 行`
          : `片段 ${item.excerpt.split('\n').length} 行`;
      lines.push(
        `| ${cell(item.path)} | ${item.line} | ${cell(`${item.why}（${size}${item.partial ? '，只读了文件头' : ''}）`)} | ${item.sha256.slice(0, 12)} |`
      );
    }
    lines.push('');
  }
  if (conversation.pageEvidence) {
    const page = conversation.pageEvidence;
    lines.push('## 附录 B　网页正文', '');
    lines.push(`- 地址：${page.url}`);
    lines.push(`- 标题：${page.title}`);
    lines.push(`- 字数：${page.chars}`);
    lines.push(`- 抓取：${formatStamp(page.fetchedAt)}，HTTP ${page.status}，sha256 ${page.sha256.slice(0, 12)}`);
    if (page.notes.length > 0) lines.push(`- 备注：${page.notes.join('；')}`);
    lines.push('');
    lines.push('```text', page.text.slice(0, 800), page.text.length > 800 ? '…' : '', '```', '');
  }
  return lines;
}

export function buildConversationMarkdown(input: MarkdownInput): string {
  const { conversation, messages } = input;
  const labels = input.labels ?? {};
  const now = input.now ?? Date.now();
  const config = conversation.executionConfig;
  const mode = config ? EXECUTION_MODE_LABELS[config.executionMode] : '未记录';
  const turns = rounds(messages);
  const asked = new Set<string>();
  for (const message of messages) if (message.channelId) asked.add(message.channelId);

  const lines: string[] = [];
  lines.push(`# ${conversation.title || '未命名会话'}`, '');
  lines.push(
    `> 本文件由 ThinkFusion 于 ${formatStamp(now)} 在本机生成：正文取自这条会话存下来的回答，` +
      '排版由导出模板决定，未经模型改写。',
    ''
  );

  lines.push('| 项目 | 内容 |', '| --- | --- |');
  lines.push(`| 会话 ID | ${conversation.conversationId} |`);
  if (conversation.workspaceMode === 'engineering') {
    lines.push(`| 工作空间 | 工程空间 · ${cell(conversation.workspaceRoot ?? '')} |`);
    if (conversation.routing) lines.push(`| 任务类型 | ${cell(routingLabel(conversation.routing))} |`);
  } else {
    lines.push(`| 工作空间 | ${workspaceLabel(conversation.workspaceMode ?? 'knowledge')} |`);
  }
  lines.push(`| 执行模式 | ${mode} |`);
  lines.push(`| 通道 | ${cell([...asked].map(id => labelOf(id, labels)).join('、') || '未记录')} |`);
  lines.push(`| 时间 | ${formatStamp(conversation.createdAt)} → ${formatStamp(conversation.updatedAt)} |`);
  lines.push('');

  let round = 0;
  turns.forEach((turn, index) => {
    const heading = turn.user ? `## 第 ${++round} 轮` : index === 0 ? '## 会话开始前的记录' : `## 记录 ${index + 1}`;
    const answers = turn.blocks.filter(message => message.role === 'channel');
    const systems = turn.blocks.filter(message => message.role === 'system');
    const synthesis = turn.blocks.find(message => message.role === 'synthesis');

    lines.push(heading, '');
    if (turn.user) {
      lines.push('### 提问', '', turn.user.text.trim(), '');
    }
    if (answers.length > 0) {
      lines.push('### 回答', '');
      for (const answer of answers) {
        lines.push(`#### ${labelOf(answer.channelId, labels)}`, '', answer.text.trim(), '');
      }
    }
    if (synthesis) {
      lines.push('### 综合结论', '');
      if (synthesis.text.trim()) lines.push(synthesis.text.trim(), '');
      if (synthesis.synthesis) lines.push(...synthesisBody(synthesis.synthesis));
    }
    if (systems.length > 0) {
      lines.push('### 过程记录', '');
      for (const message of systems) lines.push(quote(clipSystem(message.text)), '');
    }
  });

  if ((input.includeEvidence ?? true) && (conversation.engineeringEvidence?.length || conversation.pageEvidence)) {
    lines.push(...evidenceSection(conversation));
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

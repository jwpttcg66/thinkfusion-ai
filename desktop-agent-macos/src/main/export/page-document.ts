/**
 * 把网页里读到的回答整理成一份本地文档。
 *
 * 边界：这里只做**提取与排版**，一个字不改、不总结、不交给模型重写。
 * 「文档」就是页面上每条助手回答的原文（页面脚本已经读成 Markdown）；
 * 「计划」是从这些原文里挑出来的步骤条目，是同一份文字的一个索引视图，
 * 不是新写出来的计划。认不出计划就如实写「没有识别到」，不硬凑。
 */

import { formatStamp, type PageDocumentContent, type PageDocumentMessage } from '../../shared/export';

const PLAN_HEADING = /计划|步骤|任务清单|待办|路线|里程碑|行动项|实施|阶段|checklist|todo|roadmap|milestone|action\s*items|next\s*steps|plan\b|phase\s*\d/i;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+\S/;
const LIST_ITEM = /^\s*(?:[-*+]\s+|\d+[.)、]\s+|\d+、)\S/;
const HEADING = /^#{1,6}\s+\S/;
/** 附录只留节选：整段转录常有上万字，把正文挤到后面去翻不到。 */
const TRANSCRIPT_LIMIT = 6000;
const MAX_PLAN_ITEMS = 200;

export interface PageDocumentDraft {
  markdown: string;
  documents: number;
  planItems: string[];
  chars: number;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * 只认「计划块」里的列表行：先看到带计划字样的标题，或带复选框的行，
 * 才把后面连续的步骤条目收进来。
 *
 * 不加这道限制的话，一份长文档里的每个项目符号都会变成「计划」，一份
 * 说明书能凭空多出五十条待办——那不是提取，是编造。
 */
export function planItemsOf(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let inPlan = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (HEADING.test(line)) {
      inPlan = PLAN_HEADING.test(line);
      continue;
    }
    if (CHECKBOX.test(line)) inPlan = true;
    if (!inPlan) continue;
    if (!line.trim()) continue;
    if (LIST_ITEM.test(line)) {
      const item = line.trim().slice(0, 300);
      // 同一页常把一问重发一轮（交锋 / 综合），计划块就整段重复一次。
      // 完全相同的条目留一条：这是同一份文字的索引视图，不是新计划。
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
      if (out.length >= MAX_PLAN_ITEMS) break;
      continue;
    }
    // 计划块结束了：连续正文说明这一节已经不是步骤清单。
    if (out.length) inPlan = false;
  }
  return out;
}

export function buildPageDocument(
  content: PageDocumentContent,
  options: { now?: number; includeTranscript?: boolean } = {}
): PageDocumentDraft {
  // 有问答记录就按聊天记录排（问 / 答分左右），没有就沿用「文档 1…N」。
  // 后者是旧调用与没有提问选择器的站点，格式不能变。
  const messages: PageDocumentMessage[] = (content.messages?.length
    ? content.messages
    : content.documents.map(text => ({ role: 'assistant' as const, text }))
  )
    .map(message => ({ role: message.role, text: message.text.trim() }))
    .filter(message => message.text.length > 0);
  const asked = messages.filter(message => message.role === 'user').length;
  const answered = messages.length - asked;
  const hasAsk = Boolean(content.chat) || asked > 0;
  const assistantTexts = messages.filter(message => message.role === 'assistant').map(message => message.text);
  const now = options.now ?? Date.now();
  const includeTranscript = options.includeTranscript !== false;
  const planItems = planItemsOf(assistantTexts.join('\n\n'));
  const chars = messages.reduce((sum, message) => sum + message.text.length, 0);
  const title = (content.pageTitle || content.sourceLabel || '网页文档')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  const lines: string[] = [
    `# ${title}`,
    '',
    `> 由 ThinkFusion 从「${content.sourceLabel}」网页提取于 ${formatStamp(now)}；` +
      '下面的文档与计划是页面原文，未经改写或总结。',
    '',
    '## 提取概览',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 网页源 | ${cell(content.sourceLabel)} |`,
    `| 页面标题 | ${cell(content.pageTitle || title)} |`,
    `| 页面地址 | ${cell(content.url || '（页面未报告地址）')} |`,
    `| ${hasAsk ? '提取对话' : '提取文档'} | ${hasAsk ? `${messages.length} 段（提问 ${asked} / 回答 ${answered}）` : `${messages.length} 份助手回答`} / ${chars} 字 |`,
    `| 计划条目 | ${planItems.length} 条 |`,
    '',
    `## ${hasAsk ? '对话' : '文档'}`,
    ''
  ];

  if (messages.length === 0) {
    lines.push('这一页没有读到助手回答，可能是登录页或空会话。', '');
  }
  messages.forEach((message, index) => {
    const heading = hasAsk
      ? `### ${message.role === 'user' ? '问' : '答'} ${index + 1}`
      : `### 文档 ${index + 1}`;
    lines.push(heading, '', message.text, '');
  });

  lines.push('## 计划', '');
  if (planItems.length === 0) {
    lines.push('没有从上面的文档里识别到计划类条目（带「计划 / 步骤 / 待办」等标题的步骤清单，或带复选框的任务项）。', '');
  } else {
    // 条目本身已经带着 `- ` / `- [ ]` / `1.` 这样的标记，照原样排；
    // 再加一个短横会变成「- - …」，渲染出来是嵌套空列表。
    lines.push(...planItems, '');
  }

  if (includeTranscript && content.transcript.trim()) {
    const transcript = content.transcript.trim();
    const excerpt = transcript.slice(0, TRANSCRIPT_LIMIT);
    lines.push('## 附录　页面转录（节选）', '', '```text', excerpt, '```', '');
    if (transcript.length > excerpt.length) {
      lines.push(`> 转录共 ${transcript.length} 字，这里只留前 ${excerpt.length} 字；完整内容在网页源里。`, '');
    }
  }

  // 不做全文空白归一化：文档里可能夹着代码块，那里的空行是内容，不是排版。
  return { markdown: lines.join('\n').trimEnd() + '\n', documents: messages.length, planItems, chars };
}

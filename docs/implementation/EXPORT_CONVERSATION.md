# 会话导出（Markdown / Word）

2026-11-08 实现。用户裁决：「文档采用真机自己保存，格式的话需要你给才可以」。

## 责任边界

| 部分 | 谁负责 | 说明 |
| --- | --- | --- |
| 内容 | 应用自己 | 主进程读自己存的会话与消息（`conversations.get/messages`），一个字不改地搬；**不经过模型，不做第二次总结** |
| 版式 | 代码里的模板 | `src/main/export/docx.ts` 的 `TEMPLATE`：字体、标题层级、表格边框、页眉页脚。换内容不用改，换版式只改这一处 |
| 保存 | 应用自己 | 默认弹系统保存对话框（起始目录「下载」）；`path` 直写留给自动化与真机验收 |
| 选格式 | 用户 | 会话头部两个按钮：`导出 MD`（纯文本、可 diff）/ `导出 Word`（版式固定） |

为什么不让模型「写一份 docx」：它没有文件工具，也拼不出合法的 OOXML；
让它写 Word 得到的只会是改后缀的文本文件。所以模型/会话负责内容，模板负责排版。

## 链路

```
按钮（ConversationView）
  → window.agentAPI.exportConversation({ conversationId, format, path? })
  → ipcMain 'document:export'                       src/main/index.ts
  → exportConversation()                            src/main/export/index.ts
      ├─ buildConversationMarkdown()                src/main/export/markdown.ts
      └─ markdownToDocx()（仅 docx）                 src/main/export/docx.ts
  → writeFileAtomic / writeBufferAtomic             src/main/atomic-write.ts
  → { path, format, bytes, turns }   （null = 用户在对话框点了取消，不算失败）
```

## Markdown 结构

- `#` 会话标题，下面一行引用说明「由 ThinkFusion 于何时在本机生成」；
- 元信息表：会话 ID、工作空间、任务类型、执行模式、通道（显示名，`ollama:` 前缀剥掉）、时间；
- 按轮分组：`## 第 N 轮` → `### 提问` / `### 回答`（每个通道一个小标题）/ `### 综合结论`
  / `### 过程记录`。综合结论是主导人写的只留正文；规则版的「一致 / 分歧 /
  只有一家提到 / 没答上的地方」照结构列出，`finalOpinion` 单独成段；
- **过程记录截断到 900 字**：工程空间第一条系统消息带着几百字的目录清单，
  原样搬进文档读者要翻三页 dmg 名单，截断处注明「还有 N 字，完整内容见应用内会话」；
- 附录 A（工程证据表：路径、行号、为什么读、sha256、点名文件的全文行数）、
  附录 B（网页正文）。`includeEvidence: false` 可关。

## docx 模板

- A4；正文宋体 10.5pt / 西文 Times New Roman，标题黑体；页眉右上角是会话标题，
  页脚居中「第 X 页 / 共 Y 页」；
- markdown 子集：标题、段落（首行缩进两字符）、有序/无序列表、表格（表头底纹、
  0.5pt 边框）、代码块（等宽 + 浅底）、引用（左侧竖线 + 灰字）、`**粗体**` 与
  `` `行内代码` ``。认不出的语法按普通段落写入——宁可朴素，不能丢内容；
- 表格单元格里的 `|` 在 markdown 层已转义（`splitCells` 还原）；
- 依赖：`docx` 9.15.3（纯 JS，无原生编译），主进程 `require('docx')` 走 CJS 入口。

## 测试与真机

- `npm run test:export`（scripts/check-export.mjs，13 条）：内容按轮分组、
  通道名兜底、综合两种形态、证据附录开关、文件名清洗、后缀自动补齐、
  docx 是合法 zip 且含正文/表格/中文字体/页码、落盘、取消、会话不存在报错；
- 真机 s25/s26（2026-11-08）：工程空间问「全文多少行」→ 本地模型答 664 行 →
  同一条 IPC 导出 md（3.6KB）与 docx（14.5KB），unzip 验证正文、元信息表、
  附录、页眉页脚都在；界面按钮存在且可点。测试会话已删。

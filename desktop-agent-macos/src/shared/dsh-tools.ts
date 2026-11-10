/**
 * DeepSeek Harness 76 条工具 schema 的冻结清单。
 *
 * 来源：`~/data/dsh-src/docs/tool-catalog.zh.md`，提交 `ce7073d5`，
 * 包版本 `0.2.2-alpha.2`。这里只冻结「工具名 / 包 / schema 序号」这些会随
 * 上游版本变的事实；`family / ours / layer / note` 是本工程的映射，升版本时
 * 先看 `git diff` 再补。
 *
 * 四条层级口径见 `docs/spec/GENERAL_ENGINEERING_CAPABILITIES.md`：
 * L0 已有工具、L1 等价机制、L2 待补、L3 平台不适用。
 */

import type { FamilyId } from './engineering-capabilities';

export type DshLayer = 'L0' | 'L1' | 'L2' | 'L3';

export interface DshTool {
  /** schema 顺序号，1–76，用于对账。 */
  index: number;
  packageName: string;
  tool: string;
  family: FamilyId;
  /** 对应物：工具 id、能力 id 或机制名。 */
  ours: string;
  layer: DshLayer;
  /** L1 写「由谁承担」；L2 写期号；L3 写为什么平台不适用。 */
  note: string;
}

export const DSH_TOOLS: readonly DshTool[] = [
  { index: 1, packageName: 'dsh-tool-fs', tool: 'read', family: 'code.read', ours: 'fs.readFile', layer: 'L0', note: '同名能力' },
  { index: 2, packageName: 'dsh-tool-fs', tool: 'read_image', family: 'code.read', ours: 'fs.readImage', layer: 'L0', note: '同名能力' },
  { index: 3, packageName: 'dsh-tool-fs', tool: 'write', family: 'code.change', ours: 'fs.writeFile', layer: 'L0', note: '写完回读' },
  { index: 4, packageName: 'dsh-tool-fs', tool: 'edit', family: 'code.change', ours: 'fs.edit', layer: 'L0', note: '唯一字面量 + expectedHash' },
  { index: 5, packageName: 'dsh-tool-fs', tool: 'apply_patch', family: 'code.change', ours: 'fs.applyPatch', layer: 'L0', note: 'unified diff' },
  { index: 6, packageName: 'dsh-tool-str-replace-editor', tool: 'str_replace_editor', family: 'code.change', ours: 'fs.edit', layer: 'L0', note: 'view 形态用 fs.readFile' },
  { index: 7, packageName: 'dsh-tool-fs-search', tool: 'glob', family: 'code.read', ours: 'fs.find', layer: 'L0', note: '按名字找文件' },
  { index: 8, packageName: 'dsh-tool-fs-search', tool: 'grep', family: 'code.read', ours: 'fs.search', layer: 'L0', note: '按内容搜索' },
  { index: 9, packageName: 'dsh-tool-workspace-dependencies', tool: 'load_workspace_dependencies', family: 'code.read', ours: 'project.dependencies', layer: 'L0', note: '读 package.json 与锁文件' },
  { index: 10, packageName: 'dsh-experimental-tool-worktree', tool: 'create_worktree', family: 'code.change', ours: 'git.worktree', layer: 'L0', note: '参数逐个构造，不拼 shell' },
  { index: 11, packageName: 'dsh-tool-web', tool: 'web_fetch', family: 'code.read', ours: 'web.fetch', layer: 'L0', note: 'SSRF 防护、10s、2 MB' },
  { index: 12, packageName: 'dsh-tool-web', tool: 'web_search', family: 'code.read', ours: 'web.search', layer: 'L0', note: '凭据或应用内浏览器' },
  { index: 13, packageName: 'dsh-tool-executor-ptc', tool: 'run_code', family: 'runtime.exec', ours: 'code.run', layer: 'L0', note: '写盘后交给 node/python3/bash' },
  { index: 14, packageName: 'dsh-tool-bash', tool: 'bash', family: 'runtime.exec', ours: 'shell.run', layer: 'L0', note: '/bin/sh -c，真实退出码' },
  { index: 15, packageName: 'dsh-tool-jobs', tool: 'job_list', family: 'runtime.exec', ours: 'job.list', layer: 'L0', note: '后台作业列表' },
  { index: 16, packageName: 'dsh-tool-jobs', tool: 'job_output', family: 'runtime.exec', ours: 'job.output', layer: 'L0', note: '后台作业输出' },
  { index: 17, packageName: 'dsh-tool-jobs', tool: 'job_kill', family: 'runtime.exec', ours: 'job.kill', layer: 'L0', note: '按进程组结束' },
  { index: 18, packageName: 'dsh-tool-bash-persistent', tool: 'bash', family: 'runtime.exec', ours: '无持久 cwd', layer: 'L2', note: 'P5：shell.run + job.* 顶一半' },
  { index: 19, packageName: 'dsh-tool-pwsh', tool: 'pwsh', family: 'runtime.exec', ours: '无', layer: 'L3', note: 'darwin 产品没有 PowerShell' },
  { index: 20, packageName: 'dsh-tool-pwsh-persistent', tool: 'pwsh', family: 'runtime.exec', ours: '无', layer: 'L3', note: 'darwin 产品没有持久 PowerShell' },
  { index: 21, packageName: 'dsh-tool-lsp', tool: 'lsp', family: 'runtime.exec', ours: '无语言服务器', layer: 'L2', note: 'P5：先做 code.diagnostics' },
  { index: 22, packageName: 'dsh-tool-working-directory', tool: 'working_directory', family: 'runtime.exec', ours: 'workspaceRoot', layer: 'L1', note: '会话级 workspaceRoot 承担' },
  { index: 23, packageName: 'dsh-tool-terminal', tool: 'terminal_open', family: 'runtime.exec', ours: '无', layer: 'L2', note: 'P5：term.open' },
  { index: 24, packageName: 'dsh-tool-terminal', tool: 'terminal_read', family: 'runtime.exec', ours: '无', layer: 'L2', note: 'P5：term.read' },
  { index: 25, packageName: 'dsh-tool-terminal', tool: 'terminal_send', family: 'runtime.exec', ours: '无', layer: 'L2', note: 'P5：term.send' },
  { index: 26, packageName: 'dsh-tool-terminal', tool: 'terminal_signal', family: 'runtime.exec', ours: '无', layer: 'L2', note: 'P5：term.signal' },
  { index: 27, packageName: 'dsh-tool-terminal', tool: 'terminal_close', family: 'runtime.exec', ours: '无', layer: 'L2', note: 'P5：term.close' },
  { index: 28, packageName: 'dsh-tool-terminal', tool: 'terminal_list', family: 'runtime.exec', ours: '无', layer: 'L2', note: 'P5：term.list' },
  { index: 29, packageName: 'dsh-tool-ask-user', tool: 'ask_user_question', family: 'plan.control', ours: 'clarification_required', layer: 'L1', note: '协议里的澄清 + awaiting_user 承担' },
  { index: 30, packageName: 'dsh-plan-mode', tool: 'exit_plan_mode', family: 'plan.control', ours: 'plan.ready', layer: 'L1', note: '批准/退回流程承担' },
  { index: 31, packageName: 'dsh-action-cards', tool: 'propose_action', family: 'plan.control', ours: 'plan.ready + step-approval', layer: 'L1', note: '逐次审批承担' },
  { index: 32, packageName: 'dsh-tool-present', tool: 'present', family: 'plan.control', ours: 'document.export / page.save-document', layer: 'L1', note: '两个保存能力承担' },
  { index: 33, packageName: 'dsh-tool-todo', tool: 'todo_write', family: 'plan.control', ours: 'AgentPlan 步骤', layer: 'L1', note: '计划步骤与进度事件承担' },
  { index: 34, packageName: 'dsh-tool-goal', tool: 'create_goal', family: 'plan.control', ours: '无', layer: 'L2', note: 'P6：会话没有目标模型' },
  { index: 35, packageName: 'dsh-tool-goal', tool: 'get_goal', family: 'plan.control', ours: '无', layer: 'L2', note: 'P6：会话没有目标模型' },
  { index: 36, packageName: 'dsh-tool-goal', tool: 'update_goal', family: 'plan.control', ours: '无', layer: 'L2', note: 'P6：会话没有目标模型' },
  { index: 37, packageName: 'dsh-tool-schedule', tool: 'schedule_create', family: 'plan.control', ours: '无', layer: 'L2', note: 'P6：本地调度器' },
  { index: 38, packageName: 'dsh-tool-schedule', tool: 'schedule_edit', family: 'plan.control', ours: '无', layer: 'L2', note: 'P6：本地调度器' },
  { index: 39, packageName: 'dsh-tool-schedule', tool: 'schedule_list', family: 'plan.control', ours: '无', layer: 'L2', note: 'P6：本地调度器' },
  { index: 40, packageName: 'dsh-tool-schedule', tool: 'schedule_view', family: 'plan.control', ours: '无', layer: 'L2', note: 'P6：本地调度器' },
  { index: 41, packageName: 'dsh-tool-skill', tool: 'skill', family: 'memory.context', ours: 'resources/expertise', layer: 'L1', note: '按规则自动加载，不是模型工具' },
  { index: 42, packageName: 'dsh-tool-subagent', tool: 'subagent', family: 'collab.delegate', ours: 'SubAgentRegistry + 辩论成员', layer: 'L1', note: '参与者注册表承担' },
  { index: 43, packageName: 'dsh-experimental-tool-subagent-oar', tool: 'subagent_oar', family: 'collab.delegate', ours: '辩论成员 / execution-pool', layer: 'L1', note: '执行池与辩手承担' },
  { index: 44, packageName: 'dsh-tool-subagent', tool: 'list_subagent_models', family: 'collab.delegate', ours: '设置页模型清单', layer: 'L1', note: '设置页承担' },
  { index: 45, packageName: 'dsh-tool-subagent-control', tool: 'interrupt_agent', family: 'collab.delegate', ours: '会话停止 / 取消', layer: 'L1', note: '停止等待承担' },
  { index: 46, packageName: 'dsh-tool-subagent-control', tool: 'list_agents', family: 'collab.delegate', ours: '参与者栏 + selectParticipants', layer: 'L1', note: '参与者栏承担' },
  { index: 47, packageName: 'dsh-tool-subagent-control', tool: 'send_message', family: 'collab.delegate', ours: '会话内追问', layer: 'L1', note: '追问承担' },
  { index: 48, packageName: 'dsh-experimental-tool-agent-team', tool: 'interrupt_agent', family: 'collab.delegate', ours: '会话停止 / 取消', layer: 'L1', note: '同 45，同名不同包' },
  { index: 49, packageName: 'dsh-experimental-tool-agent-team', tool: 'list_agents', family: 'collab.delegate', ours: '参与者栏 + selectParticipants', layer: 'L1', note: '同 46，同名不同包' },
  { index: 50, packageName: 'dsh-experimental-tool-agent-team', tool: 'send_message', family: 'collab.delegate', ours: '会话内追问', layer: 'L1', note: '同 47，同名不同包' },
  { index: 51, packageName: 'dsh-tool-ralph', tool: 'ralph', family: 'collab.delegate', ours: '多轮编排与执行重试', layer: 'L1', note: '执行重试承担' },
  { index: 52, packageName: 'dsh-tool-workflow', tool: 'workflow', family: 'collab.delegate', ours: '计划 + 编排', layer: 'L1', note: '无脚本工作流，由计划与编排承担' },
  { index: 53, packageName: 'dsh-experimental-tool-agent-team', tool: 'spawn_teammate', family: 'collab.delegate', ours: '无', layer: 'L2', note: 'P6：团队任务板' },
  { index: 54, packageName: 'dsh-experimental-tool-agent-team', tool: 'team_task_create', family: 'collab.delegate', ours: '无', layer: 'L2', note: 'P6：团队任务板' },
  { index: 55, packageName: 'dsh-experimental-tool-agent-team', tool: 'team_task_get', family: 'collab.delegate', ours: '无', layer: 'L2', note: 'P6：团队任务板' },
  { index: 56, packageName: 'dsh-experimental-tool-agent-team', tool: 'team_task_list', family: 'collab.delegate', ours: '无', layer: 'L2', note: 'P6：团队任务板' },
  { index: 57, packageName: 'dsh-experimental-tool-agent-team', tool: 'team_task_update', family: 'collab.delegate', ours: '无', layer: 'L2', note: 'P6：团队任务板' },
  { index: 58, packageName: 'dsh-experimental-tool-agent-team', tool: 'wait_agent', family: 'collab.delegate', ours: '无', layer: 'L2', note: 'P6：团队任务板' },
  { index: 59, packageName: 'dsh-tool-session-query', tool: 'session_event_read', family: 'memory.context', ours: 'store 会话读取 + 轨迹页', layer: 'L1', note: '会话存储与轨迹承担' },
  { index: 60, packageName: 'dsh-tool-session-query', tool: 'session_event_trace', family: 'memory.context', ours: 'trace 事件流', layer: 'L1', note: '轨迹事件流承担' },
  { index: 61, packageName: 'dsh-tool-session-query', tool: 'session_trace', family: 'memory.context', ours: '轨迹 / 统计页', layer: 'L1', note: '轨迹与统计页承担' },
  { index: 62, packageName: 'dsh-tool-session-query', tool: 'session_event_search', family: 'memory.context', ours: '无', layer: 'L2', note: 'P5：session.search' },
  { index: 63, packageName: 'dsh-tool-session-query', tool: 'session_search', family: 'memory.context', ours: '无', layer: 'L2', note: 'P5：跨会话检索' },
  { index: 64, packageName: 'dsh-experimental-browser-use-stagehand-native', tool: 'stagehand_navigate', family: 'runtime.exec', ours: 'WebContentsView 装载与切换', layer: 'L1', note: '宿主页面管理承担' },
  { index: 65, packageName: 'dsh-experimental-browser-use-stagehand-native', tool: 'stagehand_observe', family: 'runtime.exec', ours: 'selector-profile + 页面探针', layer: 'L1', note: '探针承担' },
  { index: 66, packageName: 'dsh-experimental-browser-use-stagehand-native', tool: 'stagehand_extract', family: 'runtime.exec', ours: 'readAnswer + 选择器', layer: 'L1', note: '取答案承担' },
  { index: 67, packageName: 'dsh-experimental-browser-use-stagehand-native', tool: 'stagehand_act', family: 'runtime.exec', ours: '无', layer: 'L1', note: '刻意不给模型任意点击：网页通道只回答' },
  { index: 68, packageName: 'dsh-experimental-browser-use-stagehand-native', tool: 'stagehand_screenshot', family: 'runtime.exec', ours: 'screen.capture', layer: 'L1', note: '整屏截图承担；页面级截图待补' },
  { index: 69, packageName: 'dsh-experimental-browser-use-stagehand-native', tool: 'stagehand_tabs', family: 'runtime.exec', ours: '多页面管理', layer: 'L1', note: '宿主多页面管理承担' },
  { index: 70, packageName: 'dsh-plugin-manager', tool: 'plugin_manager', family: 'platform.extend', ours: '设置页内置插件开关 + CAPABILITY_CATALOG', layer: 'L1', note: '只开关，不安装第三方包' },
  { index: 71, packageName: 'dsh-plugin-market', tool: 'plugin_market', family: 'platform.extend', ours: '无', layer: 'L2', note: '需裁决：与不开放第三方包冲突' },
  { index: 72, packageName: 'dsh-mcp-resources', tool: 'list_mcp_resources', family: 'platform.extend', ours: '无', layer: 'L2', note: '需裁决：MCP 资源清单' },
  { index: 73, packageName: 'dsh-mcp-resources', tool: 'list_mcp_resource_templates', family: 'platform.extend', ours: '无', layer: 'L2', note: '需裁决：MCP 资源模板' },
  { index: 74, packageName: 'dsh-mcp-resources', tool: 'read_mcp_resource', family: 'platform.extend', ours: '无', layer: 'L2', note: '需裁决：读取 MCP 资源' },
  { index: 75, packageName: 'dsh-tool-cordis', tool: 'cordis_inspect_list', family: 'platform.extend', ours: '设置页插件清单', layer: 'L1', note: '与 CAPABILITY_CATALOG 同源' },
  { index: 76, packageName: 'dsh-tool-cordis', tool: 'cordis_inspect_query', family: 'platform.extend', ours: '无', layer: 'L2', note: 'P5：plugin.inspect' }
];

/** 76 条 schema 里的唯一工具名（71 条）。 */
export const DSH_UNIQUE_NAMES: readonly string[] = [...new Set(DSH_TOOLS.map(item => item.tool))];

/** 同名不同包的五组：升版本时最容易漏掉的就是它们。 */
export const DSH_DUPLICATE_NAMES: Readonly<Record<string, readonly string[]>> = {
  bash: ['dsh-tool-bash', 'dsh-tool-bash-persistent'],
  pwsh: ['dsh-tool-pwsh', 'dsh-tool-pwsh-persistent'],
  interrupt_agent: ['dsh-tool-subagent-control', 'dsh-experimental-tool-agent-team'],
  list_agents: ['dsh-tool-subagent-control', 'dsh-experimental-tool-agent-team'],
  send_message: ['dsh-tool-subagent-control', 'dsh-experimental-tool-agent-team']
};

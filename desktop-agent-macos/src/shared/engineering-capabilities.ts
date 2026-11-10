/**
 * 通用工程能力：工作族与治理族。
 *
 * 这不是又一张工具表，而是「一个工程活动做完是什么样」的判据表。工具 id 仍然是
 * `contracts.ts` / `capabilities.ts` 里的那一套，不改名；每条能力项把会用到的
 * 工具、前置事实、产出、反模式和验收绑在一起。
 *
 * 两个约束：
 *
 * 1. **族不互斥。** 同一个工具可以出现在多个族里（`fs.search` 既用于读代码，
 *    也用于调试）；`familiesOfTool` 返回全部命中，不强行二选一。
 * 2. **治理族不产生工程结论。** `runtime.exec` / `plan.control` / `collab.delegate`
 *    / `memory.context` / `platform.extend` 只决定怎么跑、谁来跑、跑完存哪，
 *    不能拿来证明「这行代码对不对」。
 */

export const WORK_FAMILIES = [
  'code.read',
  'code.change',
  'debug',
  'test',
  'docs',
  'data',
  'frontend',
  'review'
] as const;

export const GOVERN_FAMILIES = [
  'runtime.exec',
  'plan.control',
  'collab.delegate',
  'memory.context',
  'platform.extend'
] as const;

export type WorkFamily = (typeof WORK_FAMILIES)[number];
export type GovernFamily = (typeof GOVERN_FAMILIES)[number];
export type FamilyId = WorkFamily | GovernFamily;

export interface EngineeringCapability {
  /** 稳定 id，例如 `code.change`。 */
  id: string;
  family: FamilyId;
  /** 这件事「做完」是什么样，一句话。 */
  goal: string;
  /** 会用到的工具 / 机制名；可以重叠。 */
  tools: string[];
  /** 下结论前必须已经拿到的事实。 */
  preconditions: string[];
  /** 产出物：文件 / 报告 / 命令输出。 */
  outputs: string[];
  /** 明确不做的事。 */
  antiPatterns: string[];
  /** 验收判据，必须是能跑或能查的。 */
  acceptance: string[];
}

export const ENGINEERING_CAPABILITIES: readonly EngineeringCapability[] = [
  {
    id: 'code.read',
    family: 'code.read',
    goal: '回答「有什么 / 在哪 / 谁用谁 / 改它会波及什么」，位置能点回去。',
    tools: [
      'fs.list', 'fs.readFile', 'fs.tree', 'fs.search', 'fs.find', 'fs.stat',
      'fs.readImage', 'fs.du', 'code.diagnostics', 'project.dependencies', 'project.outline',
      'git.status', 'git.diff', 'git.log', 'git.show', 'json.query',
      'web.fetch', 'web.search', 'dns.lookup',
      'project.scan', 'project.read', 'file.attach', 'web.search.browser'
    ],
    preconditions: ['读过的文件清单', '计数类问题的真实统计来源（fs.stat 的 lines / bytes）'],
    outputs: ['带路径:行号的结论', '必要的文件清单与指纹'],
    antiPatterns: [
      '拿关键词片段当工程全貌',
      '用正则识别结果冒充 AST 结论',
      '附件被截断还报总数'
    ],
    acceptance: [
      '问「多少行」时引用 fs.stat 的真实行数',
      '问「谁调用 X」时给定义处与调用处行号',
      '找不到时明确说「未找到」'
    ]
  },
  {
    id: 'code.change',
    family: 'code.change',
    goal: '工作区出现可展示的 diff，且有一个真实检查跑过。',
    tools: [
      'fs.mkdir', 'fs.writeFile', 'fs.edit', 'fs.applyPatch', 'fs.move',
      'fs.copy', 'fs.remove', 'git.worktree', 'git.stash', 'git.branch',
      'test.run', 'code.run'
    ],
    preconditions: ['要改的位置已经读过', '改动前哈希（fs.edit 的 expectedHash）', '现有测试怎么跑'],
    outputs: ['可展示的 diff', '测试或构建的退出码', '写入后回读结果'],
    antiPatterns: [
      '多文件一起改完再说「应该可以」',
      '测试红了继续下一步',
      '把「跳过检查」写进交付清单'
    ],
    acceptance: [
      '每个写操作后 3 步内出现一次 test.run 或等价构建检查',
      '失败即停，交 review 判',
      'diff 非空且能指回文件路径'
    ]
  },
  {
    id: 'debug',
    family: 'debug',
    goal: '报告四段齐全：复现、根因、修复、复跑。',
    tools: [
      'fs.search', 'fs.readFile', 'git.log', 'git.diff', 'test.run',
      'shell.run', 'process.list', 'process.tree', 'port.list', 'window.list',
      'app.list', 'env.read', 'time.now', 'system.info'
    ],
    preconditions: ['一条能稳定复现的命令与退出码', '报错原文，不转述'],
    outputs: ['复现命令与退出码', '根因所在文件:行号', '修复后的复跑结果'],
    antiPatterns: ['没有复现就改', '同一处连改三次仍无解释', '根因写成「可能是缓存」'],
    acceptance: ['缺哪段标「未验证」', '连续三次未解决必须停下并列出已试方案']
  },
  {
    id: 'test',
    family: 'test',
    goal: '新增或修改的断言能在失败时失败、修复后通过。',
    tools: ['test.run', 'code.run', 'fs.readFile', 'text.diff'],
    preconditions: ['现有测试组织方式', '这条测试覆盖的那一行代码'],
    outputs: ['命令 + 退出码 + 用例数', '改动前为红的证据'],
    antiPatterns: ['为通过而写测试', '改断言迁就实现'],
    acceptance: ['给出「改动前是红」的证据；做不到先红必须说明原因']
  },
  {
    id: 'docs',
    family: 'docs',
    goal: '读者能据此复现或接手；每个路径都真实存在。',
    tools: ['fs.readFile', 'fs.writeFile', 'fs.applyPatch', 'git.diff', 'document.export', 'page.save-document'],
    preconditions: ['要描述的代码位置', '现有文档的写法与边界'],
    outputs: ['带真实路径的文档', '行为描述与代码位置的对应'],
    antiPatterns: ['把 diff 翻译成自然语言', '写「已支持」但没接线', '只写改了什么不写原来错在哪'],
    acceptance: ['引用的路径存在', '声称的行为有代码行或测试可指']
  },
  {
    id: 'data',
    family: 'data',
    goal: '分析可复跑，数字有来源。',
    tools: [
      'json.query', 'csv.summary', 'sqlite.query', 'code.run', 'text.base64',
      'archive.list', 'archive.extract', 'archive.create', 'image.resize',
      'fs.stat', 'fs.readFile'
    ],
    preconditions: ['输入指纹（fs.stat 的 sha256）', '数据规模（行数/字节数）'],
    outputs: ['可复跑脚本或命令', '带样本量的输出摘要'],
    antiPatterns: ['十万行 CSV 读进上下文口算', 'sqlite.query 不带 LIMIT', '把推测当统计'],
    acceptance: ['脚本落盘、命令可复跑、输出摘要带样本量']
  },
  {
    id: 'frontend',
    family: 'frontend',
    goal: '构建通过，关键路径有截图或可复现步骤。',
    tools: [
      'fs.list', 'fs.readFile', 'fs.writeFile', 'fs.edit', 'fs.applyPatch',
      'test.run', 'code.run', 'screen.capture', 'window.list', 'app.open'
    ],
    preconditions: ['现有构建/测试命令', '要验证的关键路径'],
    outputs: ['构建退出码 0', '截图或用户可照做的步骤'],
    antiPatterns: ['只改 CSS 就断言布局没问题', '没有运行态就评价交互'],
    acceptance: ['test.run 构建退出码 0', '至少一张 screen.capture 或一段可复现步骤']
  },
  {
    id: 'review',
    family: 'review',
    goal: '至少指出一个具体输入下的错误行为，或明确「未发现阻断问题」。',
    tools: ['git.diff', 'git.show', 'fs.readFile', 'text.diff', 'project.outline'],
    preconditions: ['要审的 diff 或提交', '相关实现上下文'],
    outputs: ['带位置与触发条件的意见', '明确的「未发现阻断问题」或无'],
    antiPatterns: ['逐行复述 diff', '只提风格', '把「我看不懂」写成「有风险」'],
    acceptance: ['每条意见带位置与触发条件', 'reviewExecution 规则版仍只陈述报告里读得到的事实']
  },
  {
    id: 'runtime.exec',
    family: 'runtime.exec',
    goal: '用真实进程/终端把活跑起来，拿到真实退出码或进程状态。',
    tools: [
      'shell.run', 'job.list', 'job.output', 'job.kill', 'code.run', 'test.run',
      'screen.capture', 'app.open', 'process.kill', 'clipboard.read',
      'clipboard.write', 'notify', 'system.info'
    ],
    preconditions: ['授权与沙箱状态', '要跑的命令/解释器'],
    outputs: ['退出码', 'stdout/stderr 或后台作业 id', '进程/端口状态'],
    antiPatterns: ['把「已启动」当「已成功」', '后台作业没结果就报完成', '关掉沙箱不写降级'],
    acceptance: ['退出码非空或明确 timedOut/null', '后台作业能 job.output/job.kill', '沙箱不可用要写 sandboxed:false']
  },
  {
    id: 'plan.control',
    family: 'plan.control',
    goal: '说清这次要做到什么、谁批准、什么时候做。',
    tools: ['document.export', 'page.save-document', 'plan.ready', 'step-approval', 'clarification_required', 'ask.user'],
    preconditions: ['用户目标', '权限与授权范围'],
    outputs: ['计划状态', '步骤状态', '需要用户补充的问题'],
    antiPatterns: ['模型代批计划', '把未批准计划当已执行', '跳过澄清自行假设'],
    acceptance: ['批准前不产生写入', '每个步骤有状态', '澄清问题回到用户']
  },
  {
    id: 'collab.delegate',
    family: 'collab.delegate',
    goal: '说清谁来做、怎么分工、怎么收。',
    tools: ['SubAgentRegistry', 'execution-pool', 'debate', 'followup'],
    preconditions: ['参与者名单与健康状态', '任务边界'],
    outputs: ['成员回答归属', '辩论/追加轮记录', '失败与跳过原因'],
    antiPatterns: ['参与者自己召集参与者', '静默跳过不可用成员', '把同一模型换角色当第二意见'],
    acceptance: ['每个成员的结果可追溯', '跳过/失败有原因', '并发上限生效']
  },
  {
    id: 'memory.context',
    family: 'memory.context',
    goal: '回答「以前怎么做的、这次该加载什么」。',
    tools: ['trace', 'session.search', 'resources/expertise'],
    preconditions: ['检索范围与权限', '技能触发条件'],
    outputs: ['命中片段与会话来源', '加载了哪份技能'],
    antiPatterns: ['跨会话引用不标来源与时间', '事实题也加载工程技能', '一次加载多份技能'],
    acceptance: ['0 条结果不报失败', '引用带来源会话与时间', '一次最多一份技能']
  },
  {
    id: 'platform.extend',
    family: 'platform.extend',
    goal: '说清运行时还能装什么、有什么；不安装未知第三方包。',
    tools: ['plugin.inspect', 'CAPABILITY_CATALOG', 'capabilities.*'],
    preconditions: ['当前能力清单与开关状态', '用户对安装的明确授权'],
    outputs: ['能力/插件清单', '开关状态', '缺失能力的明确说明'],
    antiPatterns: ['运行时下载第三方插件', '把未安装能力显示成可用', '静默安装 MCP 服务'],
    acceptance: ['清单与设置页同源', '未开放的能力写明「不支持」', '安装类操作需要单独裁决']
  }
];

const FAMILY_SET = new Set<string>([...WORK_FAMILIES, ...GOVERN_FAMILIES]);

export function isFamilyId(value: string): value is FamilyId {
  return FAMILY_SET.has(value);
}

/** 一个工具/机制名属于哪些族；没有归族返回空数组。 */
export function familiesOfTool(id: string): FamilyId[] {
  return ENGINEERING_CAPABILITIES
    .filter(item => item.tools.includes(id))
    .map(item => item.family);
}

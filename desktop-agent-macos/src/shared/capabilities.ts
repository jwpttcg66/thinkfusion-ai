/**
 * 能力插件契约。
 *
 * 参照 DeepSeek Harness 的形状，但不引入它的插件框架：那里每个能力都是挂到
 * `ctx.tools` 的插件，宿主按 id 查表分派，注册可逆、清单可见。我们这边原先是
 * `agent/index.ts` 一整段 `switch (step.tool)`，加上主进程里两处散装的保存
 * IPC——能力明明都在，设置里的「内置插件」却写着「还没有插件」。
 *
 * 现在所有本地能力、联网能力与所有保存能力都是插件：一套契约
 * （`CapabilityPlugin`）、一份清单（`CAPABILITY_CATALOG`）、两个装载宿主。
 * Runtime 进程装载 88 个工具（84 个本地 + 3 个联网 + 1 个语义导航代理），主进程装载工程证据
 * 读取（`project.scan` / `project.read`）、附件读取、浏览器联网搜索与两个保存动作。
 * 清单是共享的，所以两个进程和界面看到的是同一批 id、同一套权限说明。合计 94 个能力。
 *
 * 联网是一个独立类别：`web.fetch` / `web.search` 虽然跑在 Runtime，却不是
 * 「本机能力」；而 `web.search` 的免凭据兜底要借主进程的 Chromium 开窗口，
 * 那半边以前绕过注册表直接被 `agent-manager` 调，现在也登记成插件。
 *
 * 刻意不做的：不装 cordis、不加载第三方包、不支持运行时下载插件。开关只
 * 决定「这次执行要不要放行」，不卸载实现——卸载了就没法一眼看出少的是谁。
 */

import { READ_ONLY_TOOLS, TOOL_NAMES, type ToolName } from './contracts';

export type CapabilityKind = 'local' | 'network' | 'save';
/** 哪一半宿主装载这个插件。与 dsh 的 host / client 双半包同理。 */
export type CapabilityHost = 'runtime' | 'main';
export type CapabilityPermission = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CapabilityMeta {
  /** 稳定的 id。Runtime 侧就是计划里的 `step.tool`，改名会让旧计划失效。 */
  id: string;
  kind: CapabilityKind;
  host: CapabilityHost;
  title: string;
  description: string;
  permission: CapabilityPermission;
  /** 让设置页里「默认启用」这一类状态也有处可查。内置插件一律默认启用。 */
  enabledByDefault: boolean;
}

/**
 * 一个能力就是一个插件：`run` 是唯一必须实现的方法，其余都是登记信息。
 * 参数与上下文由宿主给，插件不直接抓全局状态——这样同一份插件在两个进程
 * 都能被测试、被调用，也符合 harness「通过 inject 声明依赖」的意思。
 */
// The args/results genuinely differ per plugin; a common `unknown` would force
// a cast in every single definition without buying any safety here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CapabilityPlugin<Args = any, Result = any, Context = any> extends CapabilityMeta {
  run(args: Args, context: Context): Promise<Result> | Result;
}

export interface CapabilityView extends CapabilityMeta {
  /** 当前是否被开关放行。 */
  enabled: boolean;
  /** 实现是否编译进这半边宿主并已注册。 */
  registered: boolean;
}

const LOCAL_TOOL_INFO: Record<ToolName, readonly [title: string, description: string]> = {
  'fs.list': ['列出目录', '列出工作区里某个目录的文件与子目录'],
  'fs.readFile': ['读文本文件', '按上限读取一个文本文件的内容'],
  'fs.mkdir': ['新建目录', '在工作区里创建目录'],
  'fs.writeFile': ['写文件', '新建或按哈希校验后覆盖文件，写完回读验证'],
  'fs.tree': ['目录树', '递归展开工作区目录结构'],
  'fs.search': ['按内容搜索', '在文件里搜关键词，返回路径、行号与命中行'],
  'fs.find': ['按名字找文件', '用通配符按文件名查找'],
  'fs.stat': ['文件信息', '类型、字节数、权限、修改时间与 sha256'],
  'fs.edit': ['改文件', '唯一字面量替换，可要求 expectedHash'],
  'fs.revert': ['还原本轮', '把本轮改过的文件恢复到第一次修改前的状态'],
  'fs.remove': ['删除到废纸篓', '默认移进废纸篓；永久删除只在完全权限下'],
  'fs.move': ['移动文件', '目标已存在时拒绝覆盖'],
  'fs.copy': ['复制文件', '目标已存在时拒绝覆盖'],
  'fs.readImage': ['读图片', 'PNG/JPEG/GIF/WebP 的尺寸、指纹与 base64'],
  'test.run': ['跑测试', '执行固定的构建/测试命令，拿真实退出码'],
  'shell.run': ['执行命令', '/bin/sh -c，按权限分层放行，可后台运行'],
  'job.list': ['后台作业列表', '列出仍在跑或已结束的后台命令'],
  'job.output': ['后台作业输出', '读取某个后台命令已产生的输出'],
  'job.kill': ['结束后台作业', '按进程组终止自己启动的后台命令'],
  'screen.capture': ['截屏', '抓当前屏幕并存成 PNG，带尺寸与 sha256'],
  'app.open': ['打开应用或文件', '启动应用后回读进程确认确实打开了'],
  'clipboard.read': ['读剪贴板', '读取系统剪贴板里的文字'],
  'clipboard.write': ['写剪贴板', '把文字放进系统剪贴板'],
  'notify': ['系统通知', '发一条 macOS 通知，内容走 argv 不拼脚本'],
  'system.info': ['系统信息', 'OS、CPU、内存、磁盘与电池'],
  'process.list': ['进程列表', '按名字过滤当前进程'],
  'process.kill': ['结束进程', '仅完全权限可用'],
  'web.fetch': ['抓取网页', '给定 URL 取回正文，逐跳拦截本机与私网地址'],
  'web.search': ['联网搜索', '用凭据或应用内浏览器取回真实搜索结果'],
  'fs.applyPatch': ['应用补丁', '按 unified diff 一次改多处，逐行校验上下文，带指纹校验'],
  'git.worktree': ['管理 git worktree', '列出、新增或移除工作树，参数逐个构造不拼 shell'],
  'project.dependencies': ['依赖概览', '读 package.json 与锁文件，给出依赖数量、脚本与包管理器'],
  'project.outline': ['源码骨架', '只读扫描源码，列出导出符号与所在行号，有文件数上限'],
  'git.status': ['git 状态', '当前分支、与上游的领先/落后提交数、逐文件改动'],
  'git.diff': ['git 差异', '工作区、暂存区或某次提交的差异，超大有截断标记'],
  'git.log': ['git 提交记录', '最近若干条提交的哈希、作者、时间与标题'],
  'git.show': ['看某次提交', '某次提交的说明与改动内容，可只给统计'],
  'git.stash': ['git 暂存栈', '列出、暂存、恢复或丢弃 stash，丢弃必须指明第几条'],
  'git.branch': ['git 分支', '列出、新建或切换分支，分支名逐个校验'],
  'json.query': ['查 JSON 取值', '按 a.b[0].c 或 JSON Pointer 取一个值，不用整份读进上下文'],
  'csv.summary': ['CSV 概要', '列名、空值数、去重数、样例与数值统计，自动识别分隔符'],
  'sqlite.query': ['查 SQLite', '只读打开数据库，只放行 SELECT / WITH / PRAGMA / EXPLAIN'],
  'archive.list': ['看压缩包内容', '列出 zip / tar.gz 里的条目，不写盘'],
  'archive.extract': ['解压', '解压到授权目录内，条目含绝对路径或 .. 时整包拒绝'],
  'archive.create': ['打包', '把授权目录里的文件打成 zip / tar.gz，不覆盖已有文件'],
  'text.diff': ['比对两份文件', '交给 diff -u，输出可直接喂给 fs.applyPatch'],
  'text.base64': ['base64 编解码', '把文件编成 base64，或把 base64 解码后落盘'],
  'image.resize': ['缩放图片', '用系统 sips 按长边等比缩放或指定宽高，不覆盖原图'],
  'env.read': ['读环境变量', '只读名字与值；KEY/TOKEN/SECRET 这类名字一律打码'],
  'port.list': ['监听端口', '哪个进程占着哪个端口，带 pid'],
  'app.list': ['已装应用', '列出 /Applications 等目录里的应用名，不启动任何程序'],
  'window.list': ['窗口列表', '当前可见窗口的应用名与标题，需要辅助功能授权'],
  'dns.lookup': ['域名解析', '把域名解析成 IP，属于联网动作'],
  'time.now': ['当前时间', '本机时区、ISO 时间、时间戳与星期'],
  'process.tree': ['进程树', '按父子关系展开进程，depth 表示层级'],
  'fs.du': ['目录体积', '各直接子项占多少字节与文件数，符号链接不跟随'],
  'ask.user': ['向用户提问', '执行中需要确认时暂停计划向用户提问；超时或取消返回 answered:false'],
  'code.diagnostics': ['语言诊断', '跑工程里已装的 tsc / eslint，把问题归一成路径、行号、严重级与说明'],
  'code.definition': ['跳到定义', '按 1-based 行列跳到符号定义（TypeScript 走 tsserver）'],
  'code.references': ['找引用', '列出符号的引用位置，含声明处；没有语言服务时明确报不可用'],
  'code.symbols': ['列符号', '按文件列出符号与行号（navtree）；没有语言服务时不猜'],
  'code.hover': ['看类型签名', '取光标处的类型签名与文档'],
  'code.context': ['代码上下文包', '文件符号 + 定义 + 引用 + 类型签名 + 候选测试，全部标来源'],
  'code.impact': ['影响分析', '定义/引用/调用与候选测试，按 EXACT/POSSIBLE 标置信度，可缓存'],
  'code.ast': ['按需 AST', 'TypeScript 语法树摘要：imports、声明、调用点；没有 TypeScript 时明说'],
  'code.team.run': ['多 Agent 编码', '并行出方案（探索/编码/验证/评审），Code 只回 diff，不改工作区'],
  'term.open': ['开终端', '用 node-pty 开一个持久交互式终端（与 dsh 同后端），返回会话 id'],
  'term.read': ['读终端输出', '只返回上次之后的新输出；缓冲有上限，超了会标 truncated'],
  'term.send': ['向终端输入', '把文本写进终端；submit 默认追加回车'],
  'term.signal': ['发给终端信号', 'SIGINT / SIGTERM / SIGKILL / SIGHUP / SIGQUIT，其余拒绝'],
  'term.close': ['关终端', '结束这个终端会话并回收进程组'],
  'term.list': ['列终端', '列出当前还开着的终端会话、pid、cwd 与是否已退出'],
  'session.search': ['搜历史会话', '只读搜索以前聊过什么，命中带来源会话、时间与片段；0 条不算失败'],
  'plugin.inspect': ['查能力状态', '按 id 查某个能力是否启用、注册在哪个宿主、权限是什么'],
  'goal.create': ['建目标', '按用户已批准的计划给这个会话建一个长期目标'],
  'goal.get': ['读目标', '读当前会话的目标与状态；没有就如实说没有'],
  'goal.update': ['更新目标', '模型只能更新状态（进行中/受阻/完成），不能改目标文字'],
  'schedule.create': ['建定时任务', '到点自动跑一次，只能选本地或云端，不碰网页'],
  'schedule.edit': ['改定时任务', '改文字、时间、间隔或启停'],
  'schedule.list': ['列定时任务', '列出全部定时任务与下一次运行时间'],
  'schedule.view': ['看定时任务', '看单个定时任务的上次运行与上次错误'],
  'team.spawn': ['定协作成员', '从已有参与者里选几个人登记到会话任务板，不新建成员'],
  'team.task.create': ['建任务', '在会话任务板上加一条任务，可指派给已有成员'],
  'team.task.get': ['看任务', '读一条任务的详情与状态'],
  'team.task.list': ['列任务', '列出这个会话任务板的全部任务与完成数'],
  'team.task.update': ['更新任务', '改任务状态并写一句进度；完成要有依据'],
  'team.wait': ['等任务', '返回任务板当前进度，不全就说明还差哪几条'],
  'code.run': ['跑代码', '把代码写到工作区并交给 node/python3/bash 真跑']
};

function permissionOf(id: ToolName): CapabilityPermission {
  if (id === 'process.kill') return 'danger-full-access';
  return (READ_ONLY_TOOLS as readonly string[]).includes(id) ? 'read-only' : 'workspace-write';
}

/** 联网工具的 id 不混进「本地能力」：跑在 Runtime 不代表在本机干活。 */
const NETWORK_TOOL_IDS: readonly string[] = ['web.fetch', 'web.search', 'dns.lookup'];

function kindOf(id: string): CapabilityKind {
  return NETWORK_TOOL_IDS.includes(id) || id === 'web.search.browser' ? 'network' : 'local';
}

/** 主进程这一半的插件：工程证据读取、附件读取 + 浏览器搜索 + 两个保存动作。 */
const MAIN_CAPABILITIES: readonly CapabilityMeta[] = [
  {
    id: 'project.scan',
    kind: 'local',
    host: 'main',
    title: '读取工程证据',
    description: '扫描工作区文件、统计行数与标签，给工程空间的第一意见当材料',
    permission: 'read-only',
    enabledByDefault: true
  },
  {
    id: 'file.attach',
    kind: 'local',
    host: 'main',
    title: '读取附件文件',
    description: '把用户在输入框「＋」里挑的本机文件读成文本，随这一问一起发出去；只读，不写盘',
    permission: 'read-only',
    enabledByDefault: true
  },
  {
    id: 'project.read',
    kind: 'local',
    host: 'main',
    title: '按需读取文件',
    description: '工程分析时模型自己请求读一次文件：统计行数/字节、读指定行段、搜内容、列目录；只读，范围限工程目录与这一问的附件',
    permission: 'read-only',
    enabledByDefault: true
  },
  {
    id: 'web.search.browser',
    kind: 'network',
    host: 'main',
    title: '浏览器联网搜索',
    description: '联网搜索的免凭据后端：用应用自己的 Chromium 打开 Bing 结果页，读回标题、链接与摘要',
    permission: 'read-only',
    enabledByDefault: true
  },
  {
    id: 'document.export',
    kind: 'save',
    host: 'main',
    title: '导出会话文档',
    description: '把会话存下的回答拼成 Markdown；只有点名 Word 才生成 docx',
    permission: 'workspace-write',
    enabledByDefault: true
  },
  {
    id: 'page.save-document',
    kind: 'save',
    host: 'main',
    title: '保存网页文档',
    description: '提取某个网页源当前页面里的文档与计划，写成本地文件',
    permission: 'workspace-write',
    enabledByDefault: true
  }
];

/** 全量清单：88 个 Runtime 工具 + 6 个主进程能力，合计 94。设置页只认这一份。 */
export const CAPABILITY_CATALOG: readonly CapabilityMeta[] = [
  ...TOOL_NAMES.map((id): CapabilityMeta => ({
    id,
    kind: kindOf(id),
    host: 'runtime',
    title: LOCAL_TOOL_INFO[id][0],
    description: LOCAL_TOOL_INFO[id][1],
    permission: permissionOf(id),
    enabledByDefault: true
  })),
  ...MAIN_CAPABILITIES
];

const BY_ID = new Map(CAPABILITY_CATALOG.map(meta => [meta.id, meta]));
export const CAPABILITY_IDS: readonly string[] = CAPABILITY_CATALOG.map(meta => meta.id);
export const RUNTIME_CAPABILITY_IDS: readonly string[] = CAPABILITY_CATALOG.filter(m => m.host === 'runtime').map(m => m.id);
export const MAIN_CAPABILITY_IDS: readonly string[] = CAPABILITY_CATALOG.filter(m => m.host === 'main').map(m => m.id);

export const CAPABILITY_KIND_LABELS: Record<CapabilityKind, string> = {
  local: '本地能力',
  network: '联网',
  save: '保存'
};
export const CAPABILITY_PERMISSION_LABELS: Record<CapabilityPermission, string> = {
  'read-only': '只读',
  'workspace-write': '可写工作区',
  'danger-full-access': '完全权限'
};

export function capabilityMeta(id: string): CapabilityMeta | undefined {
  return BY_ID.get(id);
}

/**
 * 存盘/传进程之前的收敛：不认识的 id 直接丢掉，重复的去重。
 * 用户手改了配置文件、或升级后某个插件被删掉，都不该让清单里冒出幽灵项。
 */
export function normalizeDisabled(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !BY_ID.has(item) || out.includes(item)) continue;
    out.push(item);
  }
  return out.slice(0, CAPABILITY_CATALOG.length);
}

/** 设置页看到的那份视图：全量清单 + 当前开关 + 实现是否已装载。 */
export function describeCapabilities(
  disabled: readonly string[] = [],
  registered: readonly string[] = CAPABILITY_IDS
): CapabilityView[] {
  const off = new Set(normalizeDisabled(disabled));
  const loaded = new Set(registered);
  return CAPABILITY_CATALOG.map(meta => ({
    ...meta,
    enabled: !off.has(meta.id),
    registered: loaded.has(meta.id)
  }));
}

/**
 * 一个宿主一份注册表。`register` 返回 disposer，所以注册是可逆的副作用
 * （对齐 harness 的 `ctx.effect()`）；`execute` 是唯一的执行入口，未装载与
 * 被停用都明确报错，不静默跳过——静默跳过最难查。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class CapabilityRegistry<Context = any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly plugins = new Map<string, CapabilityPlugin<any, any, Context>>();
  private disabled = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(plugin: CapabilityPlugin<any, any, Context>): () => void {
    if (!plugin || typeof plugin.id !== 'string' || !plugin.id) throw new Error('能力插件缺少 id');
    if (!BY_ID.has(plugin.id)) throw new Error(`能力插件不在清单里：${plugin.id}`);
    if (this.plugins.has(plugin.id)) throw new Error(`能力插件重复注册：${plugin.id}`);
    if (typeof plugin.run !== 'function') throw new Error(`能力插件没有 run：${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
    return () => {
      if (this.plugins.get(plugin.id) === plugin) this.plugins.delete(plugin.id);
    };
  }

  unregister(id: string): boolean {
    return this.plugins.delete(id);
  }

  ids(): string[] {
    return [...this.plugins.keys()];
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  meta(id: string): CapabilityMeta | undefined {
    return this.plugins.get(id);
  }

  setDisabled(raw: unknown): string[] {
    this.disabled = new Set(normalizeDisabled(raw));
    return [...this.disabled];
  }

  disabledIds(): string[] {
    return [...this.disabled];
  }

  isEnabled(id: string): boolean {
    return !this.disabled.has(id);
  }

  async execute<Result = unknown>(id: string, args: unknown, context: Context): Promise<Result> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`能力插件未装载：${id}`);
    if (!this.isEnabled(id)) throw new Error(`能力插件已停用：${plugin.title}（${id}）`);
    return (await plugin.run(args, context)) as Result;
  }
}

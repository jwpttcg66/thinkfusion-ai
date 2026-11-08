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
 * Runtime 进程装载 29 个工具（27 个本地 + 2 个联网），主进程装载工程证据
 * 读取、浏览器联网搜索与两个保存动作。清单是共享的，所以两个进程和界面
 * 看到的是同一批 id、同一套权限说明。
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
  'code.run': ['跑代码', '把代码写到工作区并交给 node/python3/bash 真跑']
};

function permissionOf(id: ToolName): CapabilityPermission {
  if (id === 'process.kill') return 'danger-full-access';
  return (READ_ONLY_TOOLS as readonly string[]).includes(id) ? 'read-only' : 'workspace-write';
}

/** 联网工具的 id 不混进「本地能力」：跑在 Runtime 不代表在本机干活。 */
const NETWORK_TOOL_IDS: readonly string[] = ['web.fetch', 'web.search'];

function kindOf(id: string): CapabilityKind {
  return NETWORK_TOOL_IDS.includes(id) || id === 'web.search.browser' ? 'network' : 'local';
}

/** 主进程这一半的插件：工程证据读取 + 浏览器搜索 + 两个保存动作。 */
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

/** 全量清单：29 个 Runtime 工具 + 4 个主进程能力。设置页只认这一份。 */
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

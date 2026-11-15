/**
 * CLI「软件源」配置的形状与校验。
 *
 * 这里只描述**这个 CLI 从哪来**，不负责安装、更新，也不承载凭据：
 * 安装/更新来源和端点都是给用户看、给排障用的记录，主进程不会拿它们
 * 去执行命令。真正决定能不能启动的是 `command` 与能力验证记录。
 *
 * 放在 shared 是因为主进程、渲染层和测试要用同一套校验；不依赖 node:
 * 内建模块，renderer 的 tsconfig 才能编译它。
 */

export type CliInstallSourceKind = 'manual' | 'npm' | 'brew' | 'url';

export interface CliSoftwareSource {
  /** 装机方式；manual 表示用户自己装、这里只记录可执行文件。 */
  kind: CliInstallSourceKind;
  /** npm 包名 / brew formula / https 下载地址；manual 时为空串。 */
  value: string;
  /** CLI 实际使用的服务端点（可选），只作记录，不替代云端 Provider 配置。 */
  endpoint?: string;
  /** 用户备注，例如版本通道；最长 120 字。 */
  note?: string;
}

export const CLI_SOURCE_KINDS: readonly CliInstallSourceKind[] = ['manual', 'npm', 'brew', 'url'];

export const CLI_SOURCE_KIND_LABELS: Record<CliInstallSourceKind, string> = {
  manual: '手动安装',
  npm: 'npm 包',
  brew: 'Homebrew',
  url: '下载地址'
};

const NPM_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
const BREW_NAME = /^[A-Za-z0-9._@+/-]+$/;
const COMMAND_BASENAME = /^[A-Za-z0-9._+-]+$/;
/** 空格允许（macOS 路径常有），shell 元字符一律不许进 argv。 */
const SHELL_META = /[;&|`$<>(){}\[\]*?!\r\n\x00-\x1f]/;

export function isHttpsUrl(raw: string): boolean {
  if (!raw || raw.length > 300) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * 命令只能是 PATH 里的名字，或一条干净的绝对路径。
 * 不解析、不执行；「这个绝对路径是不是用户亲手挑的」由主进程再查一遍。
 */
export function validateCliCommand(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('可执行文件必须是字符串');
  const command = raw.trim();
  if (!command || command.length > 500) throw new Error('可执行文件路径为空或过长');
  if (SHELL_META.test(command)) throw new Error('可执行文件路径不能包含 shell 元字符');
  if (command.includes('/')) {
    if (!command.startsWith('/')) throw new Error('绝对路径必须以 / 开头');
    if (command.endsWith('/')) throw new Error('可执行文件路径不能以 / 结尾');
    if (command.split('/').includes('..')) throw new Error('可执行文件路径不能包含 ..');
  } else if (!COMMAND_BASENAME.test(command)) {
    throw new Error('命令名只能包含字母、数字、点、下划线、加号和连字符');
  }
  return command;
}

export function isAbsoluteCliCommand(command: string): boolean {
  return command.includes('/');
}

/** 坏值一律抛错，不静默改成 manual —— 用户填错了要当场知道。 */
export function normalizeCliSoftwareSource(raw: unknown): CliSoftwareSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('软件源配置格式不对');
  const input = raw as Record<string, unknown>;
  const kind = input.kind;
  if (typeof kind !== 'string' || !CLI_SOURCE_KINDS.includes(kind as CliInstallSourceKind)) {
    throw new Error('未知的安装来源类型');
  }
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  if (value.length > 300) throw new Error('安装来源过长');
  switch (kind as CliInstallSourceKind) {
    case 'manual':
      if (value) throw new Error('手动安装不需要填写包名或地址');
      break;
    case 'npm':
      if (!NPM_NAME.test(value)) throw new Error('npm 包名不合法');
      break;
    case 'brew':
      if (!BREW_NAME.test(value) || value.includes('..')) throw new Error('Homebrew formula 不合法');
      break;
    case 'url':
      if (!isHttpsUrl(value)) throw new Error('下载地址必须是 https URL，且不能带用户名密码');
      break;
  }
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (endpoint && !isHttpsUrl(endpoint)) throw new Error('服务端点必须是 https URL');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 120) throw new Error('备注不能超过 120 字');
  return {
    kind: kind as CliInstallSourceKind,
    value,
    ...(endpoint ? { endpoint } : {}),
    ...(note ? { note } : {})
  };
}

export function describeCliSoftwareSource(source: CliSoftwareSource | undefined): string {
  if (!source) return '未登记软件来源';
  const label = CLI_SOURCE_KIND_LABELS[source.kind];
  const detail = source.value ? ` · ${source.value}` : '';
  const endpoint = source.endpoint ? ` · 端点 ${source.endpoint}` : '';
  return `${label}${detail}${endpoint}`;
}

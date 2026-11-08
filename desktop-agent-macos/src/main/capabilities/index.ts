/**
 * 主进程这一半的能力插件。
 *
 * 三个都是「在本机干活」的能力：读工程证据（本地能力）、导出会话、保存网页
 * 文档（保存）。它们需要主进程才有的东西——会话存盘、保存对话框、
 * `WebContentsView` 里的页面——所以没有塞进 Runtime 的工具表里，而是同一份
 * 契约下的另一个宿主，跟 harness 的 host / client 双半包是同一种分法。
 *
 * 依赖通过 `MainCapabilityContext` 注入，插件本身不 import Electron：这样
 * 行为测试能在 node 里直接跑，宿主换成别的实现也不用改插件。
 */

import { CapabilityRegistry, capabilityMeta } from '../../shared/capabilities';
import type { CapabilityPlugin } from '../../shared/capabilities';
import { resolveExportFormat, type ExportConversationInput, type PageDocumentContent, type SavePageDocumentInput } from '../../shared/export';
import { scanProject, type ScanOptions } from '../engineering/project';
import { exportConversation, type ExportDeps } from '../export';
import { savePageDocument, type SavePageDocumentDeps } from '../export/page';

export interface MainCapabilityContext {
  /** 会话导出要用的存盘读取与对话框。 */
  exportDeps?: () => ExportDeps;
  /** 网页文档保存要用的对话框。 */
  savePageDeps?: () => SavePageDocumentDeps;
  /** 从指定网页源的 DOM 里读出文档与计划。 */
  readPage?: (sourceId?: string) => Promise<PageDocumentContent>;
}

// Each plugin has its own argument/result shape; the registry only sees `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MainPlugin = CapabilityPlugin<any, any, MainCapabilityContext>;

function plugin(id: string, run: MainPlugin['run']): MainPlugin {
  const meta = capabilityMeta(id);
  if (!meta) throw new Error(`主进程能力不在清单里：${id}`);
  return { ...meta, run };
}

function requireDeps<T>(value: T | undefined, what: string): T {
  if (!value) throw new Error(`${what}：宿主没有提供所需依赖`);
  return value;
}

const MAIN_PLUGINS = [
  plugin('project.scan', (args: { root: string; question: string; options?: ScanOptions }) => {
    if (!args || typeof args.root !== 'string' || typeof args.question !== 'string') {
      throw new Error('读取工程证据需要工程目录与问题');
    }
    return scanProject(args.root, args.question, args.options ?? {});
  }),
  plugin('document.export', (args: ExportConversationInput, context: MainCapabilityContext) => {
    const deps = requireDeps(context?.exportDeps?.(), '导出会话文档');
    // 默认 md：只有明确点名 Word 才走 docx 模板，格式名写错也退回 md。
    return exportConversation({ ...args, format: resolveExportFormat(args?.format) }, deps);
  }),
  plugin('page.save-document', async (args: SavePageDocumentInput, context: MainCapabilityContext) => {
    const readPage = requireDeps(context?.readPage, '保存网页文档');
    const deps = requireDeps(context?.savePageDeps?.(), '保存网页文档');
    const content = await readPage(args?.sourceId);
    return savePageDocument(args, content, deps);
  })
];

export const mainCapabilities = new CapabilityRegistry<MainCapabilityContext>();
for (const item of MAIN_PLUGINS) mainCapabilities.register(item);

/**
 * V2.1 工程理解在 Runtime 里的只读工具：递归目录与内容搜索。
 *
 * 与 `main/engineering/project.ts` 的分工：那份给「分析链路」直接读工程、
 * 生成带指纹的证据；这份给「执行计划」用，让规划模型能先看清目录再决定
 * 改哪个文件。两边都只读、都有上限、都跳过依赖与凭证。
 *
 * 为什么不共用一份实现：UtilityProcess 有自己的编译边界，把 main 侧的模块
 * 拖进来会让运行时依赖整个主进程目录树。规则重复一点，边界清楚一点。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.idea', '.vscode', 'vendor', '__pycache__',
  'DerivedData', 'Pods', '.workbuddy', 'ui-preview', 'release'
]);
const IGNORED_FILES = /(\.env|\.env\.|id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$|\.key$|credentials|secrets?|token|\.sqlite$|\.db$)/i;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|java|kt|rs|rb|php|c|h|cc|cpp|swift|sh|yml|yaml|toml|css|scss|html|vue|sql|gradle|xml|txt|proto|graphql)$/i;

export interface TreeEntry { path: string; type: 'directory' | 'file'; bytes?: number }

export const projectReadTools = {
  async tree(grant: TaskGrant, args: { path: string; maxDepth?: number; maxEntries?: number }) {
    const root = await resolveGrantedPath(grant, args.path, false);
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) throw new Error('读取目标必须是目录');
    const maxDepth = Math.min(args.maxDepth ?? 4, 6);
    const maxEntries = Math.min(args.maxEntries ?? 300, 500);
    const entries: TreeEntry[] = [];
    let truncated = false;

    async function walk(dir: string, depth: number): Promise<void> {
      if (truncated || depth > maxDepth) return;
      const listed = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of listed) {
        if (entries.length >= maxEntries) { truncated = true; return; }
        const abs = path.join(dir, item.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (IGNORED_FILES.test(item.name)) continue;
        let stat;
        try { stat = await fs.lstat(abs); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (IGNORED_DIRS.has(item.name) || item.name.startsWith('.git')) continue;
          entries.push({ path: rel, type: 'directory' });
          await walk(abs, depth + 1);
        } else if (stat.isFile() && TEXT_EXT.test(item.name)) {
          entries.push({ path: rel, type: 'file', bytes: stat.size });
        }
      }
    }

    await walk(root, 0);
    return { root: args.path, entries, truncated };
  },

  /**
   * 按内容搜文本。返回 `路径:行号` 和命中行，供计划定位改动点。
   * 不做正则、不做递归到依赖目录、不读二进制；上限同时管文件数和命中数。
   */
  async search(grant: TaskGrant, args: { query: string; path?: string; maxResults?: number }) {
    const root = await resolveGrantedPath(grant, args.path ?? '.', false);
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) throw new Error('搜索起点必须是目录');
    const maxResults = Math.min(args.maxResults ?? 40, 100);
    const needle = args.query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let filesRead = 0;
    let truncated = false;

    async function walk(dir: string, depth: number): Promise<void> {
      if (truncated || depth > 5 || filesRead >= 400) return;
      const listed = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of listed) {
        if (matches.length >= maxResults || filesRead >= 400) { truncated = true; return; }
        const abs = path.join(dir, item.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (IGNORED_FILES.test(item.name)) continue;
        let stat;
        try { stat = await fs.lstat(abs); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (IGNORED_DIRS.has(item.name) || item.name.startsWith('.git')) continue;
          await walk(abs, depth + 1);
          continue;
        }
        if (!stat.isFile() || !TEXT_EXT.test(item.name) || stat.size > 262144) continue;
        let content: string;
        try {
          const buffer = await fs.readFile(abs);
          if (buffer.includes(0)) continue;
          content = buffer.toString('utf8');
        } catch { continue; }
        filesRead += 1;
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].toLowerCase().includes(needle)) continue;
          matches.push({ path: rel, line: index + 1, text: lines[index].trim().slice(0, 240) });
          if (matches.length >= maxResults) { truncated = true; break; }
        }
      }
    }

    await walk(root, 0);
    return { query: args.query, matches, filesRead, truncated };
  }
};

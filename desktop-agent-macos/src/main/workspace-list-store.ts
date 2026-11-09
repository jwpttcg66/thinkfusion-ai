/**
 * 工作区列表，落在 `userData/workspaces.json`。
 *
 * 单独一个文件，理由和 `sources.json` / `profile.json` 一样：工作区是用户自己
 * 维护的目录清单，坏了最多退回空列表；把它塞进会话存档或来源配置里，一次
 * 手改坏就会连带别的数据。
 *
 * 三条约定：
 * - **同一个目录只留一条。** 目录相等按去掉末尾斜杠后的绝对路径比较。
 * - **移除工作区不删会话。** 会话在 `agent-store.json` 里，这里只负责分组；
 *   删分组时由调用方把会话的 `workspaceId` 清掉，历史一条不少。
 * - **名字可以改，id 不跟着目录走。** 目录改名、移动之后，归在这个工作区下的
 *   会话仍然能找到自己的组。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-write';
import {
  normalizeWorkspaceEntries,
  normalizeWorkspaceName,
  normalizeWorkspaceRoot,
  sameWorkspaceRoot,
  workspaceNameFromRoot,
  type WorkspaceEntry
} from '../shared/workspace';

export interface AddWorkspaceResult {
  workspace: WorkspaceEntry;
  /** false 表示这个目录本来就是一个工作区，只是把它返回了。 */
  created: boolean;
}

export class WorkspaceListStore {
  private items: WorkspaceEntry[] = [];

  constructor(private readonly file: string) {
    try {
      this.items = normalizeWorkspaceEntries(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      this.items = [];
    }
  }

  all(): WorkspaceEntry[] {
    return this.items.map(item => ({ ...item }));
  }

  get(workspaceId: string): WorkspaceEntry | null {
    const found = this.items.find(item => item.workspaceId === workspaceId);
    return found ? { ...found } : null;
  }

  findByRoot(root: string): WorkspaceEntry | null {
    const found = this.items.find(item => sameWorkspaceRoot(item.root, root));
    return found ? { ...found } : null;
  }

  add(input: { root: string; name?: string }): AddWorkspaceResult {
    const root = normalizeWorkspaceRoot(input.root);
    if (!root) throw new Error('工作区目录不能为空。');
    if (!path.isAbsolute(root)) throw new Error('工作区必须是绝对路径。');
    const existing = this.items.find(item => sameWorkspaceRoot(item.root, root));
    if (existing) return { workspace: { ...existing }, created: false };

    const now = Date.now();
    const workspace: WorkspaceEntry = {
      workspaceId: randomUUID(),
      name: normalizeWorkspaceName(input.name) || workspaceNameFromRoot(root),
      root,
      createdAt: now,
      updatedAt: now
    };
    this.items.push(workspace);
    this.persist();
    return { workspace: { ...workspace }, created: true };
  }

  rename(workspaceId: string, name: string): WorkspaceEntry {
    const workspace = this.items.find(item => item.workspaceId === workspaceId);
    if (!workspace) throw new Error('这个工作区已经不在了。');
    const next = normalizeWorkspaceName(name);
    if (!next) throw new Error('工作区名字不能是空的。');
    if (next === workspace.name) return { ...workspace };
    workspace.name = next;
    workspace.updatedAt = Date.now();
    this.persist();
    return { ...workspace };
  }

  remove(workspaceId: string): WorkspaceEntry {
    const index = this.items.findIndex(item => item.workspaceId === workspaceId);
    if (index < 0) throw new Error('这个工作区已经不在了。');
    const [removed] = this.items.splice(index, 1);
    this.persist();
    return { ...removed };
  }

  private persist() {
    writeFileAtomic(this.file, JSON.stringify(this.items, null, 2));
  }
}

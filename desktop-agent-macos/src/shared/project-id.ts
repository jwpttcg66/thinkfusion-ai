/**
 * 工程工作区 id。
 *
 * 算法与 `code-index/service.ts` 里原来的私有实现逐字相同：
 * `p_` + `sha256(真实路径)` 前 24 位。**不能改**——已经落盘的
 * `code-index.sqlite` 与 `code_memory_facts.project_id` 都按这个算，
 * 换了算法等于所有历史项目记忆都找不到自己的项目。
 *
 * 放在 shared 是因为主进程的 code-index 与 memory 两处都要用，而 shared
 * 不允许 import Node 内建（渲染层也会编译这一目录）。
 */

import { sha256Hex } from './sha256';

export function projectIdFor(root: string): string {
  return `p_${sha256Hex(root).slice(0, 24)}`;
}

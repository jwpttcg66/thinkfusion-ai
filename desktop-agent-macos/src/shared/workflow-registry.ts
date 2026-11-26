/**
 * 生产工作流注册表（P1-04）。
 *
 * 只登记「用现有能力拼出来的固定套路」：节点里不出现模型、不出现提示词，
 * 也不接受任意脚本。选择工作流只看目标里的意图词与当前可用能力，不替用户
 * 发明任务；选不出就返回 null 并说明原因，让调用方走模型规划。
 */

import type { WorkflowDefinition } from './workflow';

export interface WorkflowCatalogEntry {
  id: string;
  title: string;
  description: string;
  /** 目标里出现这些词时优先选它；只是排序线索。 */
  intents: readonly string[];
  /**
   * 同分时的偏好：越小越简单越好（步骤少、只读优先）。
   * 只在命中数相同时起作用，不覆盖「目标真的没提」的情况。
   */
  priority?: number;
  definition: WorkflowDefinition;
}

export const WORKFLOW_REGISTRY: readonly WorkflowCatalogEntry[] = [
  {
    id: 'inspect-and-test',
    title: '读文件 → 跑测试',
    description: '先真实读取目标文件，再跑一次测试；两步都有退出码可核对。',
    intents: ['测试', 'test', '验证', '回归', '跑一遍'],
    priority: 3,
    definition: {
      id: 'inspect-and-test',
      title: '读文件 → 跑测试',
      nodes: [
        { id: 'read', capabilityId: 'fs.readFile', title: '读取目标文件' },
        {
          id: 'test',
          capabilityId: 'test.run',
          title: '跑测试',
          dependsOn: ['read']
        }
      ]
    }
  },
  {
    id: 'tree-and-test',
    title: '看结构 → 跑测试',
    description: '先列目录确认工程结构，再跑测试；适合还不清楚文件布局的仓库。',
    intents: ['结构', '目录', 'tree', '测试', 'test'],
    priority: 2,
    definition: {
      id: 'tree-and-test',
      title: '看结构 → 跑测试',
      nodes: [
        { id: 'tree', capabilityId: 'fs.tree', title: '列出工程结构' },
        {
          id: 'test',
          capabilityId: 'test.run',
          title: '跑测试',
          dependsOn: ['tree']
        }
      ]
    }
  },
  {
    id: 'read-and-run',
    title: '读文件 → 运行程序',
    description: '读取入口文件后按给定命令运行一次，用退出码与首行输出作证据。',
    intents: ['运行', '跑起来', 'run', '启动'],
    priority: 2,
    definition: {
      id: 'read-and-run',
      title: '读文件 → 运行程序',
      nodes: [
        { id: 'read', capabilityId: 'fs.readFile', title: '读取入口文件' },
        {
          id: 'run',
          capabilityId: 'code.run',
          title: '运行程序',
          dependsOn: ['read']
        }
      ]
    }
  },
  {
    id: 'write-then-verify',
    title: '写文件 → 人工确认 → 跑测试',
    description: '带审批节点：写文件前必须有人批准，写完再跑测试留证据。',
    intents: ['改文件', '写入', '修复', '修一下'],
    priority: 1,
    definition: {
      id: 'write-then-verify',
      title: '写文件 → 人工确认 → 跑测试',
      nodes: [
        {
          id: 'approve-write',
          capabilityId: '',
          kind: 'approval',
          title: '写入前人工批准'
        },
        {
          id: 'write',
          capabilityId: 'fs.writeFile',
          title: '写文件',
          dependsOn: ['approve-write']
        },
        {
          id: 'test',
          capabilityId: 'test.run',
          title: '跑测试',
          dependsOn: ['write']
        }
      ]
    }
  }
];

export function findWorkflow(id: string): WorkflowCatalogEntry | null {
  return WORKFLOW_REGISTRY.find(item => item.id === id) ?? null;
}

export function listWorkflows(): Array<{
  id: string;
  title: string;
  description: string;
  nodeCount: number;
  capabilities: string[];
}> {
  return WORKFLOW_REGISTRY.map(item => ({
    id: item.id,
    title: item.title,
    description: item.description,
    nodeCount: item.definition.nodes.length,
    capabilities: [...new Set(item.definition.nodes.filter(node => node.capabilityId).map(node => node.capabilityId))]
  }));
}

/**
 * 按目标选工作流。
 *
 * 命中意图词最多的胜出；同分时宁可返回 null（让模型规划），也不硬塞一个
 * 「差不多」的流程——工作流是固定动作，选错比不选更贵。
 */
export function selectWorkflow(
  goal: string,
  availableCapabilities: readonly string[]
): { entry: WorkflowCatalogEntry | null; reason: string; candidates: string[] } {
  const text = goal.toLowerCase();
  const available = new Set(availableCapabilities);
  const scored = WORKFLOW_REGISTRY.map(entry => {
    const missing = [...new Set(
      entry.definition.nodes.filter(node => node.capabilityId).map(node => node.capabilityId)
    )].filter(id => !available.has(id));
    const hits = entry.intents.filter(word => text.includes(word.toLowerCase())).length;
    return { entry, hits, missing };
  })
    .filter(item => item.missing.length === 0)
    .sort((a, b) => (b.hits - a.hits) || ((b.entry.priority ?? 0) - (a.entry.priority ?? 0)));

  const usable = scored.filter(item => item.hits > 0);
  if (usable.length === 0) {
    return {
      entry: null,
      reason:
        scored.length === 0
          ? '当前权限下没有能力齐全的工作流，交给模型规划'
          : '目标里没有可识别的固定套路，交给模型规划',
      candidates: scored.map(item => item.entry.id)
    };
  }
  const best = usable[0]!;
  const tied = usable.filter(
    item => item.hits === best.hits && (item.entry.priority ?? 0) === (best.entry.priority ?? 0)
  );
  if (tied.length > 1) {
    return {
      entry: null,
      reason: `${tied.map(item => item.entry.id).join('、')} 命中同样多，无法判定用哪一个`,
      candidates: usable.map(item => item.entry.id)
    };
  }
  return { entry: best.entry, reason: `目标命中 ${best.entry.intents.filter(word => text.includes(word.toLowerCase())).join('、')}`, candidates: usable.map(item => item.entry.id) };
}

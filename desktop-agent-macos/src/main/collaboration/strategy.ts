import type { ConversationExecutionConfig } from '../../shared/conversation';

/**
 * Phase F：把「哪些成员、分几轮、谁先谁后」写成一份可检查的计划。
 *
 * 两条红线，写在这里免得以后有人「优化」掉：
 *
 * 1. **任何策略都不能减少参与成员**。项目约定是所有已开启且可用的通道都
 *    要问；按意图挑一个通道看似聪明，实际上把交叉验证变成了单点答案。
 *    Smart 只改变「是否让后续成员看到前序结果」，不改变名单。
 * 2. **任何策略都不改用户的问题文本**。Sequential 传的是结构化 `context`，
 *    网页通道会忽略它，页面收到的永远是原问题。
 */
export type CollaborationStrategy = NonNullable<ConversationExecutionConfig['strategy']>;

export interface CollaborationAgent {
  id: string;
  label: string;
}

export interface CollaborationTask {
  taskId: string;
  agentId: string;
  label: string;
  /** 用户原话，每个任务都是同一句；不允许被包装、加前缀或改写。 */
  question: string;
  stage: number;
  /** 依赖的任务 id；Sequential 里是上一个 stage 的任务。 */
  dependsOn: string[];
  /** 运行时填充，计划阶段是空的。 */
  context: string[];
}

export interface CollaborationPlan {
  strategy: CollaborationStrategy;
  /** 人能读懂、能指着反驳的一句理由。 */
  reason: string;
  tasks: CollaborationTask[];
  stages: number;
  concurrency: number;
}

/** 复杂问题才值得让后面的模型看到前面的回答。规则可解释，不用模型分类。 */
const COMPLEX_HINTS = /(为什么|为何|如何|怎么|分析|比较|对比|设计|方案|原因|影响|优劣|权衡|区别|原理|机制|评估)/;

export function planCollaboration(input: {
  strategy: CollaborationStrategy;
  question: string;
  agents: readonly CollaborationAgent[];
  maxConcurrency?: number;
}): CollaborationPlan {
  const { strategy, agents } = input;
  const concurrency = Math.max(1, input.maxConcurrency ?? 4);
  const question = input.question.trim();

  // Smart 用规则决定「要不要串行传上下文」，不决定问谁。
  let effective: CollaborationStrategy = strategy;
  let reason = '';
  if (strategy === 'smart') {
    const complex = question.length > 60 || COMPLEX_HINTS.test(question);
    effective = complex ? 'sequential' : 'parallel';
    reason = complex
      ? `问题较长或含分析类词（${question.length} 字），采用递进协作：后面的模型能看到前面的回答`
      : `问题偏事实型（${question.length} 字），并行独立作答，避免前面的回答带偏后面的模型`;
  }

  if (effective === 'sequential') {
    const tasks: CollaborationTask[] = agents.map((agent, index) => ({
      taskId: `seq-s${index}-${index}`,
      agentId: agent.id,
      label: agent.label,
      question,
      stage: index,
      dependsOn: index > 0 ? [`seq-s${index - 1}-${index - 1}`] : [],
      context: []
    }));
    return {
      strategy,
      reason: reason || `递进协作：${agents.length} 个成员依次作答，后者带前序结果`,
      tasks,
      stages: tasks.length,
      concurrency: 1
    };
  }

  const all = strategy === 'all-selected';
  const tasks: CollaborationTask[] = agents.map((agent, index) => ({
    taskId: `par-s0-${index}`,
    agentId: agent.id,
    label: agent.label,
    question,
    stage: 0,
    dependsOn: [],
    context: []
  }));
  return {
    strategy,
    reason: reason || (all
      ? `全模型协作：${agents.length} 个成员一次性并行`
      : `并行协作：${agents.length} 个成员，每批最多 ${Math.min(concurrency, agents.length)} 个`),
    tasks,
    stages: 1,
    // all-selected 刻意不分批：它的语义就是「所有模型同时看到同一个问题」。
    concurrency: all ? Math.max(1, agents.length) : concurrency
  };
}

/**
 * 「工程设计和实施」这个技能要不要在这一轮加载。
 *
 * 用规则，不用模型：多一次生成只是小事，判错时把「这个文件多少行」也套上
 * 一套「先给执行计划、写→验→报」的流程，才是真的坏——本地模型会回一段
 * 任务分解而不是 664 行，前面几轮真机验收过的读文件能力就白做了。
 *
 * 判定口径复用 `classifyDecision`：那套规则本来就把「读数、查事实、定位
 * 报错」排除在决策之外，也是用户裁决过、有测试守着的。这里只补两类它不
 * 覆盖的实施动作（设计 / 实现 / 改造 / 修 bug），并让纯事实题优先出局。
 */

import { classifyDecision } from '../research/second-opinion';

/** 明确是查事实 / 计数 / 定位，且没有实施动作词时，一律不加载。 */
const FACT_ONLY =
  /多少行|多少条|多少次|多少字节|几个字节|多少字|总共多少|一共多少|统计|计数|出现了几次|出现几次|第几行|在哪一行|报错|读一下|读出来|查一下|查查|找出来|是什么|干什么|有没有/;

/** 真正在做设计、实现、改造的动作词。命中即算实施场景。 */
const WORK_VERBS = [
  '设计',
  '架构',
  '实现',
  '开发',
  '改造',
  '重构',
  '迁移',
  '选型',
  '集成',
  '接入',
  '封装',
  '拆分',
  '加个',
  '加一个',
  '新建',
  '写个',
  '写一段',
  '写代码',
  '改一下',
  '改成',
  '优化',
  '修',
  '补上',
  '落地',
  '怎么改',
  '如何做',
  '怎么做',
  '怎么实现'
];

export interface SkillTrigger {
  load: boolean;
  /** 写进系统消息，让用户能核对这一轮为什么加载 / 没加载。 */
  reason: string;
  /** 命中的词。 */
  signals: string[];
}

export function shouldLoadEngineeringSkill(question: string): SkillTrigger {
  const text = (question || '').toLowerCase();
  const work = WORK_VERBS.filter(word => text.includes(word.toLowerCase()));

  if (FACT_ONLY.test(question) && work.length === 0) {
    return {
      load: false,
      reason: '这一问是读数 / 查事实 / 定位，按工程证据直接回答，不套设计实施流程',
      signals: []
    };
  }

  const decision = classifyDecision(question);
  if (decision.major) {
    return {
      load: true,
      reason: `问题涉及拍板或取舍（${decision.signals.join('、') || '决策信号'}），加载工程设计与实施`,
      signals: [...decision.signals, ...work]
    };
  }

  if (work.length > 0) {
    return {
      load: true,
      reason: `问题在实施 / 改造（${work.join('、')}），加载工程设计与实施`,
      signals: work
    };
  }

  return {
    load: false,
    reason: '这一问没有设计或实施动作，按工程证据直接回答',
    signals: []
  };
}

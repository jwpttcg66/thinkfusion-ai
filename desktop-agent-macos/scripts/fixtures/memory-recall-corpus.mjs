/**
 * 召回质量固定语料 `corpus-v1`（`GLOBAL_MEMORY.md` §2.4）。
 *
 * 40 条记录 / 24 条查询，其中 8 条**必须空召回**。所有时间戳写死，
 * 保证扫描阈值与指标在任何机器上都可复现。
 *
 * 改动公式或本文件必须同时改 `RECALL_CORPUS_VERSION`，否则
 * `check-memory-recall.mjs` 会红——防止「调参数让测试变绿」悄悄发生。
 *
 * 覆盖：中文短句 8 / 中英混合 6 / Java 类名与方法名 6 / 路径与符号 4 /
 * 同义表达 4 / 过期 3 / 冲突 3 / 无关 6。
 */

export const CORPUS_VERSION = 'corpus-v1';
export const NOW = 1_763_827_200_000; // 2026-11-22，固定
const DAY = 86_400_000;

function rec(id, overrides) {
  return {
    memoryId: id,
    kind: 'fact',
    scope: 'PROJECT',
    scopeId: 'p_alpha',
    title: '',
    content: '',
    normalizedKey: id,
    sourceRefs: ['conversation:c1', 'message:m1'],
    evidenceRefs: [],
    codeRefs: [],
    tags: [],
    confidence: 0.9,
    status: 'active',
    riskLevel: 'low',
    sensitivity: 'normal',
    createdAt: NOW - 20 * DAY,
    updatedAt: NOW - 2 * DAY,
    lastConfirmedAt: NOW - 5 * DAY,
    supersedes: [],
    schemaVersion: 1,
    ...overrides
  };
}

const sym = name => ({ symbolKey: `p_alpha|java|${name}|method` });

export const records = [
  // --- 中文短句 8 ---
  rec('r01', { kind: 'constraint', title: '迁移前先跑 staging', content: '所有数据库迁移前必须先在 staging 环境验证', tags: ['迁移', 'staging'] }),
  rec('r02', { kind: 'constraint', title: '提交信息用中文', content: 'git 提交信息一律写中文，说清原来错在哪', tags: ['提交', '中文'] }),
  rec('r03', { kind: 'constraint', title: '提交前跑 typecheck', content: '提交前必须跑 typecheck 和测试，不许跳过失败的测试', tags: ['typecheck', '测试'] }),
  rec('r04', { kind: 'constraint', title: '不要 push', content: '只允许本地 commit，禁止 push，推送由用户自己做', tags: ['commit', 'push'] }),
  rec('r05', { kind: 'decision', title: '单源也要自辩', content: '只有一个源时，一个源承担回答汇总自辩最终意见全部角色', tags: ['单源', '自辩'] }),
  rec('r06', { kind: 'constraint', title: '网页原话直发', content: '网页通道用户原话逐字发送，不套角色行与引导语', tags: ['网页', '原话'] }),
  rec('r07', { kind: 'decision', title: 'CLI 是第三类回答源', content: 'CLI 属于云端主导的一种，可以回答可以辩论可以执行', tags: ['CLI', '回答源'] }),
  rec('r08', { kind: 'decision', scope: 'GLOBAL', scopeId: '', title: '完全权限自动批准', content: 'danger-full-access 档计划自动批准，审批门槛随权限变化', tags: ['权限', '审批'] }),

  // --- 中英混合 6 ---
  rec('r09', { kind: 'constraint', title: 'Web 不注入记忆', content: 'Web 通道默认不做隐藏记忆注入，网页原话保持不变', tags: ['Web', '注入'] }),
  rec('r10', { kind: 'decision', title: 'Provider 返回 systemHash', content: 'Provider 适配器从 assembled messages 反抽 system 段算三级指纹', tags: ['Provider', 'systemHash'] }),
  rec('r11', { kind: 'decision', title: 'requestId 契约', content: 'task answer trace usage 四处 requestId 同值便于反查', tags: ['requestId', 'trace'] }),
  rec('r12', { kind: 'decision', title: 'memory.sqlite 用 WAL', content: '独立数据库 journal_mode 用 WAL，busy_timeout 设 5000', tags: ['WAL', 'sqlite'] }),
  rec('r13', { kind: 'decision', title: '中文走字符 bigram', content: '中文短句按字符 bigram 切分，代码标识符整段双保留', tags: ['bigram', '切分'] }),
  rec('r14', { kind: 'constraint', title: '记忆预算上限', content: 'maxRecords 五条和 budgetChars 一千二百字是上限不是目标', tags: ['预算', '上限'] }),

  // --- Java 类名 / 方法名 6 ---
  rec('r15', { kind: 'fact', title: 'Redisson 分布式锁', content: 'Redisson 分布式锁用于订单幂等去重', tags: ['Redisson', 'lock'], codeRefs: [sym('Redisson.getLock')] }),
  rec('r16', { kind: 'fact', title: 'Unsafe_AllocateMemory0 调用', content: 'Unsafe_AllocateMemory0 在堆外内存分配时触发', tags: ['Unsafe_AllocateMemory0'], codeRefs: [sym('Unsafe_AllocateMemory0')] }),
  rec('r17', { kind: 'decision', title: 'code_memory_facts 迁移', content: 'code_memory_facts 一次性迁入 memory_records 后转只读', tags: ['code_memory_facts', '迁移'] }),
  rec('r18', { kind: 'fact', title: 'HelloEverybody.java', content: 'HelloEverybody 程序输出 hello everybody 到控制台', tags: ['HelloEverybody', 'java'] }),
  rec('r19', { kind: 'procedure', title: 'javac 编译后运行', content: 'javac 编译 Java 源码后用 java 命令把程序真的跑起来', tags: ['javac', 'java'] }),
  rec('r20', { kind: 'fact', title: 'Graphiti 可选增强', content: 'Graphiti 是可选外部图谱增强，不是基础闭环的前置条件', tags: ['Graphiti', '图谱'] }),

  // --- 路径与符号 4 ---
  rec('r21', { kind: 'fact', title: 'memory/store.ts 存储层', content: '存储层在 src/main/memory/store.ts，写操作一律事务', tags: ['store.ts', 'SQLite'] }),
  rec('r22', { kind: 'fact', title: 'engineering-round.ts 证据', content: 'engineering-round.ts 里写着只依据这些证据回答', tags: ['engineering-round.ts'] }),
  rec('r23', { kind: 'fact', title: 'code-index.sqlite 不搬', content: 'code-index.sqlite 保留工程代码索引职责，链接表只读解析', tags: ['code-index.sqlite'] }),
  rec('r24', { kind: 'fact', title: 'cli-answer-agent.ts 无 system', content: 'cli-answer-agent.ts 只能拼文本前缀，没有 system 轮次', tags: ['cli-answer-agent.ts'] }),

  // --- 同义表达 4（与 r01..r04 同义，措辞不同）---
  rec('r25', { kind: 'constraint', title: '预发布环境先验证', content: '上线前先在预发布 staging 环境跑一遍数据库迁移', tags: ['预发布', 'staging'] }),
  rec('r26', { kind: 'constraint', title: 'commit message 用中文', content: 'git commit message 一律中文，写清原来错在哪', tags: ['commit', '中文'] }),
  rec('r27', { kind: 'constraint', title: '单元测试与类型检查', content: '提交前跑单元测试和类型检查，失败不许提交', tags: ['单元测试', '类型检查'] }),
  rec('r28', { kind: 'constraint', title: '只在本地提交', content: '不要推到远端，只做本地提交，推送由用户自己来', tags: ['本地提交'] }),

  // --- 过期 3（硬过滤）---
  rec('r29', { kind: 'fact', title: '旧缓存淘汰策略', content: '旧的缓存淘汰策略已废弃不再采用', expiresAt: NOW - DAY }),
  rec('r30', { kind: 'fact', title: '旧调试端口', content: '旧的调试端口号已停用', expiresAt: NOW - 2 * DAY }),
  rec('r31', { kind: 'fact', title: '旧密钥轮换周期', content: '旧的密钥轮换周期已过期失效', expiresAt: NOW - 3 * DAY }),

  // --- 冲突 3（状态非 active）---
  rec('r32', { kind: 'decision', status: 'superseded', title: '已被替代的架构决策', content: '旧版决定把记忆放在 JSON 文件里', supersededBy: 'r33' }),
  rec('r33', { kind: 'decision', status: 'refuted', title: '被否定的推断', content: '曾被推断 CLI 可以结构化注入 system' }),
  rec('r34', { kind: 'fact', status: 'expired', title: '已过期的临时结论', content: '临时记录某次任务状态，已失效' }),

  // --- 无关 6（英文独有词，与中文查询零共享 token）---
  rec('r35', { kind: 'fact', title: 'Quantum topology notes', content: 'Quantum topology seminar notes are unrelated to this project' }),
  rec('r36', { kind: 'fact', title: 'Weekend soccer league', content: 'Weekend soccer league schedule and standings' }),
  rec('r37', { kind: 'fact', title: 'Tomato egg recipe', content: 'Tomato and egg stir fry recipe with salt' }),
  rec('r38', { kind: 'fact', title: 'Rainfall probability', content: 'Tomorrow rainfall probability forecast' }),
  rec('r39', { kind: 'fact', title: 'Passport visa service', content: 'Passport and visa application service desk' }),
  rec('r40', { kind: 'fact', title: 'Deep sea vent ecology', content: 'Deep sea hydrothermal vent ecology survey' })
];

/** 所有「绝不能注入」的 id：过期、被替代、被否定、无关。 */
export const FORBIDDEN_IDS = ['r29', 'r30', 'r31', 'r32', 'r33', 'r34', 'r35', 'r36', 'r37', 'r38', 'r39', 'r40'];

export const queries = [
  // 16 条非空召回
  { projectId: 'p_alpha', question:'数据库迁移前要先做什么验证', expectedIds: ['r01', 'r25'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'git 提交信息应该用什么语言写', expectedIds: ['r02', 'r26'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'提交前要跑 typecheck 和什么检查', expectedIds: ['r03', 'r27'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'可以 push 到远端吗', expectedIds: ['r04', 'r28'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'只配置一个模型时还要自辩吗', expectedIds: ['r05'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'网页通道能加角色提示词吗', expectedIds: ['r06'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'CLI 属于哪一类回答来源', expectedIds: ['r07'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'完全权限档还要人工审批计划吗', expectedIds: ['r08'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'Web 会偷偷注入隐藏记忆吗', expectedIds: ['r09'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'Provider 怎么证明记忆送达', expectedIds: ['r10'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'requestId 在几处保持一致', expectedIds: ['r11'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'memory.sqlite 用什么日志模式', expectedIds: ['r12'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'中文短句按什么切分', expectedIds: ['r13'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'记忆最多注入几条和多少字', expectedIds: ['r14'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'Redisson 分布式锁用在哪', expectedIds: ['r15'], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'Unsafe_AllocateMemory0 什么时候触发', expectedIds: ['r16'], mustNotContainIds: FORBIDDEN_IDS },

  // 8 条必须空召回（库里没有对应的事）
  { projectId: 'p_alpha', question:'量子拓扑弦论', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'周末足球联赛', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'番茄炒蛋配方', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'明日降雨概率', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'护照签证办理', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'篮球三分规则', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'古典吉他调弦', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS },
  { projectId: 'p_alpha', question:'深海热泉生态', expectedIds: [], mustNotContainIds: FORBIDDEN_IDS }
];

/** 供测试断言：非空查询数 / 空查询数。 */
export const COUNTS = {
  records: records.length,
  queries: queries.length,
  emptyQueries: queries.filter(q => q.expectedIds.length === 0).length
};

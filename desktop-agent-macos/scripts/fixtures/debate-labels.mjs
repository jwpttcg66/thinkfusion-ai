/**
 * 质量基准集（任务书 14.2 / 14.3 / Phase 5）。
 *
 * **这些标签是「规则基准」，不是人工标注。** `labelSource` 只有两种：
 *
 * - `rule`：期望值由任务书条款 / AC 直接推出（例如「没有可核验来源就不能判
 *   supported」来自 §7.2 + AC-12）。复核方式是读那条条款，不是问模型。
 * - `seed`：本仓库自带的示例标签，用来把评测链路跑通，**未经人工复核**。
 *
 * `human` 一条都没有。报告里三种分开算，绝不把「与规则基准一致」写成
 * 「事实准确率」。要拿事实准确率，得有人逐条标注正确答案（见
 * `DEBATE_QUALITY.md` 的达标线）。
 *
 * 每条 `basis` 写清「凭什么期望这个档位」，避免标签变成照抄系统当前输出——
 * 否则改了实现标签也跟着改，评测就什么也测不出来。
 *
 * 回放格式：`rounds[i][agentId]` 是那位在第 i 轮说的话，`citations` 模拟页面
 * 读到的引用链接。
 */

const DOC = 'https://docs.example.com/release-notes';
const ISSUE = 'https://github.com/example/repo/issues/481';

/** 一句话说清「无来源 → 判不了」，很多条共用这个依据。 */
const NO_SOURCE_BASIS =
  '任务书 §7.1「现有工具无法获得足够证据，应输出 inconclusive」+ AC-13：' +
  '没有可核验来源时判 insufficient_evidence，不能为了好看硬给结论';

export const LABELED_CASES = [
  // ---- 原 4 条：少数派、纯断言、错误前提、可复现反证 --------------------
  {
    id: 'EVAL-01',
    question: '这个库在 6.0 之前支持并发写入吗？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '不支持。官方 release notes 写明 6.0 才加入并发写入，之前的版本会丢写。',
      b: '我印象里一直可以并发写，没遇到过问题。'
    }],
    citations: { a: [{ url: DOC, anchorText: 'release notes', title: 'Release notes' }] },
    expectVerdict: 'supported',
    expectAnyOf: ['release notes', '6.0'],
    labelSource: 'seed',
    basis: '一方给出可点击的官方出处、另一方只是印象；§7.2 官方文档优先级高于个人经验'
  },
  {
    id: 'EVAL-02',
    question: '这套配置在生产环境能扛住每秒一万次写入吗？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '可以，这套配置很成熟，很多公司都在用。',
      b: '没问题，我们线上就是这么配的，一直很稳。'
    }],
    expectVerdict: null,
    labelSource: 'rule',
    basis: NO_SOURCE_BASIS + '；AC-12 规定两边都只有断言时，人数一致不构成证据'
  },
  {
    id: 'EVAL-03',
    question: 'IPv4 地址一共有 32 位，所以可用地址就是 32 个，对吗？',
    strategy: 'assumption',
    participants: ['a', 'b'],
    rounds: [{
      a: '这个前提不对：32 位指的是地址长度，可用地址数是 2 的 32 次方，约 43 亿，还要扣掉保留段。',
      b: '位数和个数不是一回事，32 位对应约 43 亿个地址。'
    }],
    expectVerdict: 'insufficient_evidence',
    expectAnyOf: ['2 的 32 次方', '43 亿'],
    wrongPremise: true,
    labelSource: 'seed',
    basis: 'TF-D-006 要求纠正错误前提（关键词命中）；但「2^32」没有页面链接，按 §7.2 规则只能判证据不足——不是错，是规则判不了'
  },
  {
    id: 'EVAL-04',
    question: '这个接口在并发调用下会返回重复数据吗？',
    strategy: 'adversarial',
    participants: ['a', 'b', 'c'],
    rounds: [{
      a: '不会，接口是幂等的，可以放心并发调。',
      b: '不会重复，我们压测过。',
      c: '会。这个接口的分页游标不是快照，6.2 之前的实现里并发写入会让同一条记录出现在两页，官方 issue #481 有复现步骤。'
    }],
    citations: { c: [{ url: ISSUE, anchorText: 'issue #481', title: 'Duplicate rows under concurrent writes' }] },
    expectVerdict: 'supported',
    expectAnyOf: ['游标', 'issue'],
    labelSource: 'rule',
    basis: 'TF-D-008 / TF-D-011：两票说没问题、一票给可复现的官方 issue，AC-12 要求少数派凭证据胜出'
  },

  // ---- 补齐 TF-D-001 ~ 010 里原本没有期望档位的场景 ---------------------
  {
    id: 'EVAL-05',
    title: 'TF-D-001 金属与骨头硬度',
    question: '金属和骨头哪个更硬？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '硬度要按指标比较：莫氏硬度里骨头大约 5，普通钢铁可以到 5.5 以上，不能笼统说金属更硬。',
      b: '不同金属差别很大，铝的莫氏硬度只有 2.5 到 3，比骨头软，必须指明是哪种金属、哪个硬度指标。'
    }],
    expectVerdict: 'insufficient_evidence',
    expectAnyOf: ['莫氏', '指标'],
    forbidAnyOf: ['金属一定比骨头硬', '所有金属都比骨头硬'],
    labelSource: 'rule',
    basis: 'TF-D-001 要求明确硬度指标与材料差异、不输出绝对化结论；两方都没给可核验来源，按 §7.1 判不了真假'
  },
  {
    id: 'EVAL-06',
    title: 'TF-D-002 Java 堆外内存',
    question: 'Java 进程堆外内存一直涨，怎么排查？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '堆外内存要分开看：NMT 统计 JVM 自身的分配，Unsafe.allocateMemory 走的是 malloc，glibc arena 的碎片化也会让 RSS 上涨。',
      b: '先对比 NMT 的 committed 和进程 RSS，差额里还要扣掉线程栈、code cache 和 DirectByteBuffer，不能只看一个数字。'
    }],
    expectVerdict: 'insufficient_evidence',
    expectAnyOf: ['NMT', 'malloc', 'RSS'],
    labelSource: 'rule',
    basis: NO_SOURCE_BASIS + '；TF-D-002 要求区分 NMT / Unsafe / malloc / RSS 与碎片化证据，这些是口径不是来源'
  },
  {
    id: 'EVAL-07',
    title: 'TF-D-003 版本与配置证据',
    question: 'Netty 在 glibc 环境下内存为什么不释放？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '这个行为取决于 Netty 版本和 glibc 版本：4.1.50 之后 pool 的回收策略有调整，glibc 2.26 之后 tcache 改变了 arena 的复用方式。',
      b: '没有版本号和 JVM 参数判断不了，先给出 MALLOC_ARENA_MAX 和 -XX:MaxDirectMemorySize 的实际配置。'
    }],
    expectVerdict: 'insufficient_evidence',
    expectAnyOf: ['版本', '配置'],
    labelSource: 'rule',
    basis: 'TF-D-003 明确要求「要求版本和配置证据」；发言自己都说「没有版本号判断不了」，判 supported 就是自相矛盾'
  },
  {
    id: 'EVAL-08',
    title: 'TF-D-007 多个模型共同犯错',
    question: '这个库支持并发写入吗？',
    strategy: 'truth',
    participants: ['a', 'b', 'c'],
    rounds: [{
      a: '这个库支持并发写入，可以放心用。',
      b: '这个库支持并发写入，我一直在用。',
      c: '这个库支持并发写入，没有问题。'
    }],
    expectVerdict: null,
    expectAnyOf: [],
    labelSource: 'rule',
    basis: 'AC-12 / TF-D-007：三人一致但零来源，多数一致不得自动变成正确；expectVerdict: null 表示「只要不是 supported」'
  },
  {
    id: 'EVAL-09',
    title: 'TF-D-009 同源转载',
    question: '默认连接数是多少？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '默认连接数是 1024，官方文档写明了。',
      b: '默认连接数应该是 1024，官方文档就是这么写的。'
    }],
    citations: {
      a: [{ url: `${DOC}?spm=a1`, anchorText: '官方文档', title: 'Release notes' }],
      b: [{ url: `https://www.google.com/url?q=${encodeURIComponent(DOC)}`, anchorText: '官方文档', title: 'Release notes' }]
    },
    expectVerdict: 'supported',
    expectAnyOf: ['1024'],
    labelSource: 'rule',
    basis: 'AC-10 / TF-D-012：两个入口指向同一份官方文档，只算一个独立来源；有官方链接且主张可核验，仍可判 supported'
  },
  {
    id: 'EVAL-10',
    title: 'TF-D-010 证据不足或工具失败',
    question: '这个版本的行为到底是什么？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '这个版本的行为我记不清了，可能是 3.2 之后改的。',
      b: '现有信息判断不了，需要看具体版本的 changelog。'
    }],
    expectVerdict: 'insufficient_evidence',
    labelSource: 'rule',
    basis: 'TF-D-010 要求输出 insufficient_evidence / inconclusive，不伪造结论'
  },

  // ---- 对抗用例：判据收紧后不许回退 -------------------------------------
  {
    id: 'EVAL-11',
    title: 'ADV-01 归档材料撑不起当前版本',
    question: '在 7.0 里默认值是多少？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '在 7.0 里默认值改成了 2048。',
      b: '我看到的材料写的也是 2048。'
    }],
    citations: {
      a: [{ url: 'https://docs.example.com/v1/manual', anchorText: '配置手册', title: 'v1.0 配置手册（已归档）' }]
    },
    expectVerdict: 'partially_supported',
    expectAnyOf: ['2048'],
    labelSource: 'rule',
    basis: '任务书 §7.3 时效性：来源标注 v1.0 且写明归档，主张问 7.0，材料适用范围对不上，最多部分支持'
  },
  {
    id: 'EVAL-12',
    title: 'ADV-02 空洞推理不能被当成有依据',
    question: '这个库可靠吗？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '它很可靠，因为它是可靠的。',
      b: '这个库支持并发写入，因为大家都这么说。'
    }],
    expectVerdict: 'insufficient_evidence',
    labelSource: 'rule',
    basis: '任务书 §7.1 LogicJudge 要判推理是否成立；循环论证与诉诸众人不是依据，且两句都没有可核验来源'
  },
  {
    id: 'EVAL-13',
    title: 'ADV-03 规范陈述里的「所有」不是绝对化断言',
    question: 'HTTP/1.1 请求必须带什么头？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [{
      a: '所有 HTTP/1.1 请求都必须带 Host 头。',
      b: '规范要求请求必须带 Host 头，否则返回 400。'
    }],
    citations: {
      a: [{ url: 'https://www.rfc-editor.org/rfc/rfc7230', anchorText: 'RFC 7230', title: 'RFC 7230 Section 5.4' }]
    },
    expectVerdict: 'supported',
    expectAnyOf: ['Host'],
    labelSource: 'rule',
    basis: '协议规范里的全称量词是量化范围，不是过度概括；有 RFC 链接可核验，不该因含「所有」被降档'
  }
];

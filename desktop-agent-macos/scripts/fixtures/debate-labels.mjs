/**
 * 标注集（Phase 5 的评测输入）。
 *
 * **重要：这些标签是本仓库自带的示例标签（`labelSource: 'seed'`），不是人工
 * 复核过的基准。** 它们按任务书 14.2 的场景写成，用来把「评测这条链路」跑通，
 * 并让指标随代码变化；在有人逐条复核之前，报告里的准确率只能读成「和示例
 * 标签的一致程度」，不能读成「事实准确率」。
 *
 * 每条用例的 `rounds[i][agentId]` 是那位在第 i 轮说的话（回放，不是真模型），
 * `citations` 模拟页面读到的引用链接。`expectVerdict: null` 表示「只要不是
 * supported 就算对」——用于「证据不足 / 工具失败」这类场景。
 */

const DOC = 'https://docs.example.com/release-notes';

export const LABELED_CASES = [
  {
    id: 'EVAL-01',
    question: '这个库在 6.0 之前支持并发写入吗？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '不支持。官方 release notes 写明 6.0 才加入并发写入，之前的版本会丢写。',
        b: '我印象里一直可以并发写，没遇到过问题。'
      }
    ],
    citations: { a: [{ url: DOC, anchorText: 'release notes', title: 'Release notes' }] },
    expectVerdict: 'supported',
    expectAnyOf: ['release notes', '6.0'],
    labelSource: 'seed',
    note: '一方给出可点击的官方出处，另一方只是印象'
  },
  {
    id: 'EVAL-02',
    question: '这套配置在生产环境能扛住每秒一万次写入吗？',
    strategy: 'truth',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '可以，这套配置很成熟，很多公司都在用。',
        b: '没问题，我们线上就是这么配的，一直很稳。'
      }
    ],
    expectVerdict: null,
    labelSource: 'seed',
    note: '两边都只有断言，没有任何可核验来源：不能给 supported'
  },
  {
    id: 'EVAL-03',
    question: 'IPv4 地址一共有 32 位，所以可用地址就是 32 个，对吗？',
    strategy: 'assumption',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '这个前提不对：32 位指的是地址长度，可用地址数是 2 的 32 次方，约 43 亿，还要扣掉保留段。',
        b: '位数和个数不是一回事，32 位对应约 43 亿个地址。'
      }
    ],
    expectVerdict: 'insufficient_evidence',
    expectAnyOf: ['2 的 32 次方', '43 亿'],
    wrongPremise: true,
    labelSource: 'seed',
    note: '问题本身带错误前提。两方都纠正了（关键词命中），但「2^32 = 43 亿」是算术常识、没有任何页面链接可核验，按本仓库的裁判规则只能给 insufficient_evidence——不是错，是规则判不了'
  },
  {
    id: 'EVAL-04',
    question: '这个接口在并发调用下会返回重复数据吗？',
    strategy: 'adversarial',
    participants: ['a', 'b', 'c'],
    rounds: [
      {
        a: '不会，接口是幂等的，可以放心并发调。',
        b: '不会重复，我们压测过。',
        c: '会。这个接口的分页游标不是快照，6.2 之前的实现里并发写入会让同一条记录出现在两页，官方 issue #481 有复现步骤。'
      }
    ],
    citations: { c: [{ url: 'https://github.com/example/repo/issues/481', anchorText: 'issue #481', title: 'Duplicate rows under concurrent writes' }] },
    expectVerdict: 'supported',
    expectAnyOf: ['游标', 'issue'],
    labelSource: 'seed',
    note: '两票说没问题，一票给出可复现的官方 issue：少数派有更强证据'
  }
];

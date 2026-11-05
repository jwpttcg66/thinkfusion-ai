/**
 * TF-D-001 ~ TF-D-010 的固定回放（任务书 14.2 / AC-15）。
 *
 * 为什么是「回放」而不是「真跑模型」：同样的问题，模型每次说的话都不一样，
 * 断言「模型说了 X」的测试第二天就会红，而且红得没有意义。这里录的是**一次
 * 典型发言**（答案文本按任务书场景写成），断言的是**结构**：
 *
 * - 句子被正确切成主张、关键词没有被丢掉；
 * - 该判成争议的判出来了；
 * - 证据不足时不硬给结论、多数一致不自动变正确、少数派有依据就胜出；
 * - 转载不被算成两份独立来源。
 *
 * 所以这一组守的是「链路不会把真话弄丢」，不是「模型判断正确」。真模型的
 * 质量要靠人工标注集（Phase 5），这一组替不了。
 *
 * 每条 `rounds[i][agentId]` 是那位参与者在第 i 轮说的话；`citations` 模拟
 * 页面读到的引用链接。
 */

const DOC = 'https://docs.example.com/release-notes';

export const CASES = [
  {
    id: 'TF-D-001',
    title: '金属与骨头硬度比较',
    question: '金属和骨头哪个更硬？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '硬度要按指标比较：莫氏硬度里骨头大约 5，普通钢铁可以到 5.5 以上，不能笼统说金属更硬。',
        b: '不同金属差别很大，铝的莫氏硬度只有 2.5 到 3，比骨头软，必须指明是哪种金属、哪个硬度指标。'
      }
    ],
    expect: [
      ['claimsMentionAll', ['莫氏', '硬度']],
      ['claimsMentionAll', ['指标']],
      ['noAbsoluteConclusion'],
      ['verdictNot', 'supported']
    ]
  },
  {
    id: 'TF-D-002',
    title: 'Java 堆外内存增长排查',
    question: 'Java 进程堆外内存一直涨，怎么排查？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '堆外内存要分开看：NMT 统计 JVM 自身的分配，Unsafe.allocateMemory 走的是 malloc，glibc arena 的碎片化也会让 RSS 上涨。',
        b: '先对比 NMT 的 committed 和进程 RSS，差额里还要扣掉线程栈、code cache 和 DirectByteBuffer，不能只看一个数字。'
      }
    ],
    expect: [
      ['claimsMentionAll', ['NMT', 'Unsafe', 'malloc']],
      ['claimsMentionAll', ['RSS']]
    ]
  },
  {
    id: 'TF-D-003',
    title: 'Netty 与 glibc arena 行为',
    question: 'Netty 在 glibc 环境下内存为什么不释放？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '这个行为取决于 Netty 版本和 glibc 版本：4.1.50 之后 pool 的回收策略有调整，glibc 2.26 之后 tcache 改变了 arena 的复用方式。',
        b: '没有版本号和 JVM 参数判断不了，先给出 MALLOC_ARENA_MAX 和 -XX:MaxDirectMemorySize 的实际配置。'
      }
    ],
    expect: [
      ['claimsMentionAll', ['版本']],
      ['claimsMentionAll', ['配置']],
      ['verdictNot', 'supported']
    ]
  },
  {
    id: 'TF-D-004',
    title: 'Redis 连接复用方案比较',
    question: 'Redis 客户端怎么做连接复用？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: 'Redis 单连接上可以流水线发多条命令，但 Cluster 下不同 key 落在不同节点，连接不能跨节点复用。',
        b: 'Lettuce 的复用依赖它是线程安全的共享连接，Jedis 需要连接池；故障语义也不同，重连会丢掉未确认的命令。'
      }
    ],
    expect: [
      ['claimsMentionAll', ['Cluster']],
      ['claimsMentionAll', ['连接池']]
    ]
  },
  {
    id: 'TF-D-005',
    title: 'Ollama 本地模型选择',
    question: '本地跑 Ollama，7B 还是 14B？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '先看内存：7B 的 q4 大约要 6GB，上下文拉到 8k 还会涨；并发 4 路时显存不够会退到 CPU，吞吐掉一半。',
        b: '质量上 14B 在中文任务明显好于 7B，但 16GB 内存跑不动 14B 的 q4 加 8k 上下文，得先量一下峰值。'
      }
    ],
    expect: [
      ['claimsMentionAll', ['内存']],
      ['claimsMentionAll', ['并发']],
      ['claimsMentionAll', ['上下文']]
    ]
  },
  {
    id: 'TF-D-006',
    title: '用户问题包含错误前提',
    question: 'Redis 是单线程的，所以它不能处理并发请求，对吗？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '这个前提不对：Redis 的单线程指的是命令执行，网络 IO 在 6.0 之后是多线程的，而且它能同时处理大量并发连接。',
        b: '要纠正一下：单线程不等于不能并发，Redis 用 IO 多路复用处理并发连接，只有慢命令才会阻塞其他请求。'
      }
    ],
    expect: [
      ['correctsPremise'],
      ['claimsMentionAll', ['并发']]
    ]
  },
  {
    id: 'TF-D-007',
    title: '多个模型共同犯错',
    question: '这个库支持并发写入吗？',
    participants: ['a', 'b', 'c'],
    rounds: [
      {
        a: '这个库支持并发写入，可以放心用。',
        b: '这个库支持并发写入，我一直在用。',
        c: '这个库支持并发写入，没有问题。'
      }
    ],
    expect: [
      ['noSupportedClaims'],
      ['verdictNot', 'supported'],
      ['conclusionNull']
    ]
  },
  {
    id: 'TF-D-008',
    title: '少数派观点有更强证据',
    question: '这个库支持并发写入吗？',
    participants: ['a', 'b', 'c'],
    rounds: [
      {
        a: '这个库支持并发写入，可以放心用。',
        b: '这个库支持并发写入，我一直在用。',
        c: '这个库在 6.0 之前不支持并发写入，官方 release notes 写明了这一点。',
        citations: {
          c: [{ url: `${DOC}?utm_source=web`, anchorText: 'release notes', title: 'Release notes' }]
        }
      }
    ],
    expect: [
      ['minorityWins'],
      ['verdictIs', 'supported'],
      ['claimsMentionAll', ['6.0']]
    ]
  },
  {
    id: 'TF-D-009',
    title: '证据来源互相转载',
    question: '默认连接数是多少？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '默认连接数是 1024，官方文档写明了。',
        b: '默认连接数应该是 1024，官方文档就是这么写的。',
        citations: {
          a: [{ url: `${DOC}?spm=a1`, anchorText: '官方文档', title: 'Release notes' }],
          b: [{ url: 'https://www.google.com/url?q=https://docs.example.com/release-notes', anchorText: '官方文档', title: 'Release notes' }]
        }
      }
    ],
    expect: [
      ['independentSourcesAtMost', 1],
      ['duplicateEvidenceAtLeast', 1]
    ]
  },
  {
    id: 'TF-D-010',
    title: '证据不足或工具失败',
    question: '这个版本的行为到底是什么？',
    participants: ['a', 'b'],
    rounds: [
      {
        a: '这个版本的行为我记不清了，可能是 3.2 之后改的。',
        b: '现有信息判断不了，需要看具体版本的 changelog。'
      }
    ],
    expect: [
      ['verdictIs', 'insufficient_evidence'],
      ['conclusionNull']
    ]
  }
];

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewMaterial, reviewConclusion, reviewExecution, ruleReview } from '../out-test/main/engineering/review.js';

const report = {
  protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 't', roundId: 'r', planId: 'p',
  status: 'completed', results: [], errors: [], nextAction: 'complete', createdAt: 1,
  verification: { verified: true, reasons: [], changedFiles: 0 }
};
const plan = { steps: [] };

test('评审只有“需修复”结论、没有问题项时不阻塞交付', async () => {
  const verdict = await reviewExecution(report, plan, {
    reviewer: 'model', ask: async () => '【结论】需修复'
  });
  assert.equal(verdict.needsFix, false);
  assert.deepEqual(verdict.issues, []);
});

test('评审给出具体问题时仍阻塞', async () => {
  const verdict = await reviewExecution(report, plan, {
    reviewer: 'model', ask: async () => '【结论】需修复\n- 测试未覆盖用户校验失败分支'
  });
  assert.equal(verdict.needsFix, true);
  assert.match(verdict.issues.join('\n'), /未覆盖/);
});

// ---------------------------------------------------------------------------
// 2026-11-22 真机：Java 任务其实跑通了（javac + java，stdout 就是 hello everybody），
// 评审却写「报告中没有展示运行命令的 stdout，因此无法确认」。原因是交给评审的
// 材料只有「shell.run: completed」。评审看不到的证据，它只能判成没有。
// ---------------------------------------------------------------------------

const javaPlan = {
  protocol: 'desktop-agent/v1', type: 'plan', taskId: 't', roundId: 'r',
  title: '写一个 Java 类并真机运行', description: '输出 hello everybody',
  steps: [
    { id: 's1', tool: 'fs.writeFile', args: { path: 'java-hello/HelloEverybody.java', content: 'class HelloEverybody {}' } },
    { id: 's2', tool: 'shell.run', args: { command: 'javac -encoding UTF-8 HelloEverybody.java && java -Dfile.encoding=UTF-8 HelloEverybody' } }
  ],
  completion: { condition: 'java 真实输出 hello everybody' }
};

const javaReport = {
  protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 't', roundId: 'r', planId: 'p',
  status: 'completed', errors: [], nextAction: 'complete', createdAt: 1,
  results: [
    { stepId: 's1', tool: 'fs.writeFile', status: 'completed', verified: true, durationMs: 2,
      args: { path: 'java-hello/HelloEverybody.java' }, result: { created: true, path: 'java-hello/HelloEverybody.java', bytes: 130 } },
    { stepId: 's2', tool: 'shell.run', status: 'completed', verified: true, durationMs: 812,
      args: { command: 'javac -encoding UTF-8 HelloEverybody.java && java -Dfile.encoding=UTF-8 HelloEverybody' },
      result: { command: 'javac -encoding UTF-8 HelloEverybody.java && java -Dfile.encoding=UTF-8 HelloEverybody', exitCode: 0, stdout: 'hello everybody\n', stderr: '', timedOut: false } }
  ],
  evidence: { refs: [{ kind: 'command', command: 'javac -encoding UTF-8 HelloEverybody.java && java -Dfile.encoding=UTF-8 HelloEverybody', exitCode: 0, at: 1 }] },
  verification: {
    verified: true, reasons: [], changedFiles: 1, changedPaths: ['java-hello/HelloEverybody.java'],
    checks: {
      compile: { status: 'passed', exitCode: 0, command: 'javac -encoding UTF-8 HelloEverybody.java && java -Dfile.encoding=UTF-8 HelloEverybody' },
      tests: { status: 'skipped' },
      diagnostics: { status: 'skipped', errors: 0, warnings: 0 },
      changedFiles: ['java-hello/HelloEverybody.java']
    }
  }
};

test('评审材料带上每一步的真实输出、退出码与验证结论', () => {
  const material = buildReviewMaterial(javaReport, javaPlan);
  assert.match(material, /hello everybody/);
  assert.match(material, /退出码：0/);
  assert.match(material, /【验证判定】已通过/);
  assert.match(material, /- 编译：passed（退出码 0）/);
  assert.match(material, /- 改动文件：java-hello\/HelloEverybody\.java/);
  // 写了哪个文件、多少字节，评审要能自己对上。
  assert.match(material, /java-hello\/HelloEverybody\.java/);
  // 没有命令的步骤不能凭空长出 stdout 段落，但也不能把结果吞掉。
  assert.match(material, /字节|bytes|created/);
});

test('javac 真跑通时不追着要 test.run', () => {
  const review = ruleReview(javaReport, javaPlan);
  assert.deepEqual(review.issues, []);
  assert.match(review.summary, /能观察结果的检查 1 次/);
});

test('验证没通过时，原因原样进评审的问题列表', () => {
  const blocked = {
    ...javaReport,
    verification: {
      ...javaReport.verification,
      verified: false,
      reasons: ['改了文件，但没有任何成功的构建 / 测试 / 运行断言或诊断：本轮不能算已验证']
    }
  };
  const review = ruleReview(blocked, javaPlan);
  assert.match(review.issues.join('\n'), /没有任何成功的构建/);
});

test('结论是通过、只在解释「缺少某诊断不影响结论」时不阻塞交付', async () => {
  const verdict = await reviewExecution(javaReport, javaPlan, {
    reviewer: 'model',
    ask: async () => '未发现明显功能问题。\n缺少独立诊断不影响本次结论，因为编译成功、运行输出正确、测试断言通过。\n【结论】通过'
  });
  assert.equal(verdict.needsFix, false);
  assert.deepEqual(verdict.issues, []);
});

// ---------------------------------------------------------------------------
// 2026-11-26 真机：一个 134 秒该结束的任务跑了 421 秒。评审原文写着
// 「不需要修复」，但判定用的是 /需要修复/ 正则，把否定句也算了进去，
// 于是又开了一轮修复；后面两轮里评审已经在说「未发现明显问题，说明无功能
// 缺陷」，仍被逐行抓成待修项。结论优先 + 否定句过滤要一起钉住。
// ---------------------------------------------------------------------------

test('结论解析：不需要修复 / 无需修复不算需修复', () => {
  assert.equal(reviewConclusion('改动符合预期，不需要修复。\n【结论】通过'), 'pass');
  assert.equal(reviewConclusion('【结论】无需修复，可以交付'), 'pass');
  assert.equal(reviewConclusion('【结论】需修复'), 'fix');
  assert.equal(reviewConclusion('【结论】不通过'), 'fix');
  // 正文里没有【结论】时，看最后一句。
  assert.equal(reviewConclusion('整体看下来\n改动符合完成条件，可以收尾。'), 'pass');
  assert.equal(reviewConclusion('有些地方还说不清'), 'unclear');
});

test('评审写「不需要修复」时不阻塞交付', async () => {
  const verdict = await reviewExecution(javaReport, javaPlan, {
    reviewer: 'model',
    ask: async () => '编译与运行都有输出，改动符合完成条件。\n不需要修复。\n【结论】通过'
  });
  assert.equal(verdict.needsFix, false);
  assert.deepEqual(verdict.issues, []);
});

test('结论通过时，解释性句子（说明无功能缺陷）不进待修列表', async () => {
  const verdict = await reviewExecution(javaReport, javaPlan, {
    reviewer: 'model',
    ask: async () =>
      '逐条核对：\n- 未发现明显问题，说明无功能缺陷\n- 不是错误：输出里少一行空行\n【结论】通过'
  });
  assert.equal(verdict.needsFix, false);
  assert.deepEqual(verdict.issues, []);
  assert.match(verdict.verdict, /通过/);
});

test('结论通过也压不住规则层事实：验证缺口仍阻塞', async () => {
  const blocked = {
    ...javaReport,
    verification: {
      ...javaReport.verification,
      verified: false,
      reasons: ['改了文件，但没有任何成功的构建 / 测试 / 运行断言或诊断：本轮不能算已验证']
    }
  };
  const verdict = await reviewExecution(blocked, javaPlan, {
    reviewer: 'model',
    ask: async () => '看起来没问题。\n【结论】通过'
  });
  assert.equal(verdict.needsFix, true);
  assert.match(verdict.issues.join('\n'), /没有任何成功的构建/);
});

test('结论写需修复但没有可执行问题时，如实说明而不是假装通过', async () => {
  const verdict = await reviewExecution(javaReport, javaPlan, {
    reviewer: 'model',
    ask: async () => '【结论】需修复'
  });
  assert.equal(verdict.needsFix, false);
  assert.match(verdict.verdict, /没有指出可执行的问题/);
});

test('评审材料带上步骤自己的验收条件', () => {
  const planWithAcceptance = {
    ...javaPlan,
    steps: [
      {
        ...javaPlan.steps[0],
        description: '写入 HelloEverybody.java',
        acceptance: '文件里只有一个 public class'
      },
      { ...javaPlan.steps[1], acceptanceCriteria: ['java 退出码 0', 'stdout 含 hello everybody'] }
    ]
  };
  const material = buildReviewMaterial(javaReport, planWithAcceptance);
  assert.match(material, /说明：写入 HelloEverybody\.java；文件里只有一个 public class/);
  assert.match(material, /java 退出码 0；stdout 含 hello everybody/);
});

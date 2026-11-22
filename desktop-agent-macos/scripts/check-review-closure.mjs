import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewMaterial, reviewExecution, ruleReview } from '../out-test/main/engineering/review.js';

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

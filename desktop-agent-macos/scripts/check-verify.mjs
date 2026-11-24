/**
 * 「本轮验没验过」：只按执行报告里的事实判，不按模型自称。
 *
 * Run with: npm run test:verify
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyExecution, hasGenuineDelivery } from '../out-test/agent/verification.js';
import { verificationIsComplete } from '../out-test/shared/task-view.js';

const report = (verification) => ({ verification });
const checks = (over = {}) => ({
  compile: { status: 'skipped' }, run: { status: 'skipped' }, tests: { status: 'skipped' },
  diagnostics: { status: 'skipped', errors: 0, warnings: 0 }, changedFiles: [], ...over
});

const step = (tool, status, result = null, args = undefined) => ({ stepId: tool, tool, status, result, durationMs: 1, ...(args ? { args } : {}) });

test('改了文件 + 成功的测试：算已验证', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'a.ts' }),
    step('test.run', 'completed', { exitCode: 0, stdout: '' }, { command: 'npm test' })
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.changedFiles, 1);
  assert.equal(outcome.checks.tests.status, 'passed');
  assert.equal(outcome.checks.tests.exitCode, 0);
  assert.equal(outcome.checks.compile.status, 'skipped');
});

test('编译与测试分开记：typecheck 归 compile，npm test 归 tests', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'a.ts' }),
    step('test.run', 'completed', { exitCode: 0 }, { command: 'npm run typecheck' }),
    step('test.run', 'failed', { exitCode: 1 }, { command: 'npm test' })
  ]);
  assert.equal(outcome.checks.compile.status, 'passed');
  assert.equal(outcome.checks.tests.status, 'failed');
  assert.equal(outcome.verified, true, '编译通过仍然满足「验过」');
  assert.match(outcome.reasons.join('；'), /测试失败/);
});

test('changedPaths 去重：同一文件改两次，路径只留一个', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'src/a.ts' }, { path: 'src/a.ts' }),
    step('fs.applyPatch', 'completed', { path: 'src/a.ts' }, { path: 'src/a.ts' }),
    step('code.diagnostics', 'completed', { counts: { errors: 0, warnings: 0 } })
  ]);
  assert.equal(outcome.changedFiles, 2, '兼容旧语义：成功写了几次');
  assert.deepEqual(outcome.changedPaths, ['src/a.ts']);
  assert.deepEqual(outcome.checks.changedFiles, ['src/a.ts']);
});

test('改了文件 + 诊断 0 error：算已验证', () => {
  const outcome = verifyExecution([
    step('fs.applyPatch', 'completed', { path: 'a.ts' }),
    step('code.diagnostics', 'completed', { counts: { errors: 0, warnings: 2 } })
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.checks.diagnostics.status, 'passed');
  assert.equal(outcome.checks.diagnostics.errors, 0);
  assert.equal(outcome.checks.diagnostics.warnings, 2);
});

test('改了文件但只跑了失败测试：不算', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'a.ts' }),
    step('test.run', 'completed', { exitCode: 1 })
  ]);
  assert.equal(outcome.verified, false);
  assert.match(outcome.reasons.join('；'), /不能算已验证/);
});

test('shell.run 里真编译 + 运行断言：算已验证（真实 Java 工程踩过）', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'hello-jwp/src/main/java/com/example/App.java' }),
    step('shell.run', 'completed', { exitCode: 0, stdout: '实际输出: [hello jwp]\nVERIFIED\n' }, {
      command: 'rm -rf out && javac -encoding UTF-8 -d out src/main/java/com/example/App.java && out=$(java -cp out com.example.App) && [ "$out" = "hello jwp" ]'
    })
  ]);
  assert.equal(outcome.verified, true, '编译 + 输出断言就是验证过');
  assert.equal(outcome.checks.compile.status, 'passed');
  assert.equal(outcome.checks.tests.status, 'passed', '字符串断言算功能验证');
});

test('shell.run 只跑 mvn package 也算编译证据', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'pom.xml' }),
    step('shell.run', 'completed', { exitCode: 0 }, { command: 'mvn -B -q -DskipTests package' })
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.checks.compile.status, 'passed');
});

test('shell.run 里的版本探测不算编译过', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'a.java' }),
    step('shell.run', 'completed', { exitCode: 0 }, {
      command: "echo '== javac =='; javac -version 2>&1 || echo 'javac: NOT FOUND'; java -version 2>&1"
    })
  ]);
  assert.equal(outcome.verified, false, '查版本不等于编译');
  assert.equal(outcome.checks.compile.status, 'skipped');
});

test('echo / mkdir / chmod 这类命令不构成任何证据', () => {
  for (const command of [
    'mkdir -p a/b && ls -R a',
    'chmod +x run.sh && ls -l run.sh',
    "echo 'make sure it works'",
    // 文件名里带 .java 不是「跑了 java」：真机 ls 那一步曾被误认成运行。
    'ls -l HelloEverybody.java HelloEverybody.class'
  ]) {
    const outcome = verifyExecution([
      step('fs.writeFile', 'completed', { path: 'a.txt' }),
      step('shell.run', 'completed', { exitCode: 0 }, { command })
    ]);
    assert.equal(outcome.verified, false, command);
  }
});

test('诊断里还有 error：不算', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'a.ts' }),
    step('code.diagnostics', 'completed', { counts: { errors: 1, warnings: 0 } })
  ]);
  assert.equal(outcome.verified, false);
});

test('写操作自己失败：不算，且理由直说', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'failed', null),
    step('test.run', 'completed', { exitCode: 0 })
  ]);
  assert.equal(outcome.verified, false);
  assert.match(outcome.reasons.join('；'), /写操作失败/);
});

test('没有写操作：trivially verified，但理由写明无需验证', () => {
  const outcome = verifyExecution([step('fs.readFile', 'completed', { content: 'x' })]);
  assert.equal(outcome.verified, true);
  assert.match(outcome.reasons.join('；'), /无需验证/);
});

test('验证结果带 changedPaths：编排器据此判断改的是不是代码', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'src/a.ts' }, { path: 'src/a.ts' }),
    step('test.run', 'completed', { exitCode: 0 })
  ]);
  assert.deepEqual(outcome.changedPaths, ['src/a.ts']);
});

// ---------------------------------------------------------------------------
// 2026-11-22 用户原话：「可以跑 java 程序，输出到控制台或日志，是可以测试的」。
// 真机那条 Java 任务跑了 `javac … && java …`，屏幕上是 hello everybody，验收
// 界面却写着「测试 未执行」——运行没有被当成检查。
// ---------------------------------------------------------------------------

test('javac && java 真跑起来：运行单独记一项，带控制台输出', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'java-hello/HelloEverybody.java' }),
    step('shell.run', 'completed', { exitCode: 0, stdout: 'hello everybody\n' }, {
      command: 'javac -encoding UTF-8 HelloEverybody.java && java -Dfile.encoding=UTF-8 HelloEverybody'
    })
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.checks.compile.status, 'passed');
  assert.equal(outcome.checks.run.status, 'passed', '跑起来就是验证过');
  assert.equal(outcome.checks.run.output, 'hello everybody');
});

test('只编译不运行：compile 通过，run 记为未执行', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'a.java' }),
    step('shell.run', 'completed', { exitCode: 0 }, { command: 'javac -d out a.java' })
  ]);
  assert.equal(outcome.checks.compile.status, 'passed');
  assert.equal(outcome.checks.run.status, 'skipped');
});

test('java -version 不是运行程序', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'a.java' }),
    step('shell.run', 'completed', { exitCode: 0 }, { command: 'java -version 2>&1' })
  ]);
  assert.equal(outcome.checks.run.status, 'skipped');
  assert.equal(outcome.verified, false);
});

test('后台启动的服务不算跑完：没有退出码就不记通过', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'server.js' }),
    step('shell.run', 'completed', { stdout: 'listening on 3000\n' }, { command: 'npm run dev' })
  ]);
  assert.equal(outcome.checks.run.status, 'skipped');
  assert.equal(outcome.verified, false);
});

test('运行失败时理由写清楚是「程序运行失败」', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'Main.java' }),
    step('shell.run', 'failed', { exitCode: 1, stderr: 'Exception in thread "main"' }, { command: 'java Main' })
  ]);
  assert.equal(outcome.verified, false);
  assert.match(outcome.reasons.join('；'), /程序运行失败/);
});

test('运行写在命令替换里也认：output="$(java App)" + 字符串断言', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'HelloEverybody.java' }),
    step('shell.run', 'completed', { exitCode: 0, stdout: 'hello everybody\n' }, {
      command: 'javac HelloEverybody.java\noutput="$(java HelloEverybody)"\necho "$output"\n[ "$output" = "hello everybody" ]'
    })
  ]);
  assert.equal(outcome.checks.run.status, 'passed', '双引号里的 $(java …) 不是字面量');
  assert.equal(outcome.checks.run.output, 'hello everybody');
  assert.equal(outcome.verified, true);
});

test("echo 'java Foo' 这种引号字面量仍不算运行", () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'a.txt' }),
    step('shell.run', 'completed', { exitCode: 0 }, { command: "echo 'java Foo'" })
  ]);
  assert.equal(outcome.checks.run.status, 'skipped');
});

// 空轮假完成闸门：复刻真机事故——写失败轮 + 只列目录的空轮 + 模型一句「完成」。
test('hasGenuineDelivery：无报告历史按兼容放行（纯问答/旧数据）', () => {
  assert.equal(hasGenuineDelivery([]), true);
});

test('hasGenuineDelivery：写失败轮 + 空轮 trivially verified 不算真交付', () => {
  const failedRound = report({
    verified: false, reasons: ['1 个写操作失败'], changedFiles: 0, changedPaths: [],
    checks: checks()
  });
  const emptyRound = report({
    verified: true, reasons: ['本轮没有写操作，无需验证'], changedFiles: 0, changedPaths: [],
    checks: checks()
  });
  assert.equal(hasGenuineDelivery([failedRound, emptyRound]), false);
});

test('hasGenuineDelivery：至少一轮真的跑过编译/运行/测试才算交付', () => {
  const failedRound = report({
    verified: false, reasons: ['写失败'], changedFiles: 0, changedPaths: [], checks: checks()
  });
  const realRound = report({
    verified: true, reasons: ['编译通过'], changedFiles: 1,
    changedPaths: ['HelloJwp.java'],
    checks: checks({ compile: { status: 'passed', exitCode: 0 }, changedFiles: ['HelloJwp.java'] })
  });
  assert.equal(hasGenuineDelivery([failedRound, realRound]), true);
});

test('hasGenuineDelivery：目标本就正确、没写文件但 javac+java 跑通也算真交付', () => {
  // 真机踩过的坑：源码本来就对，两轮只做 fs.stat/编译运行、changedFiles=0，
  // 曾被误判成假完成并重规划死循环。跑通就是交付，不要求一定写文件。
  const ranOnly = report({
    verified: true, reasons: ['本轮没有写操作，无需验证'], changedFiles: 0, changedPaths: [],
    checks: checks({ compile: { status: 'passed', exitCode: 0 }, run: { status: 'passed', exitCode: 0, output: 'hello jwp' } })
  });
  assert.equal(hasGenuineDelivery([ranOnly]), true);
});

test('hasGenuineDelivery：写了文件但没有任何通过的检查不算交付', () => {
  const noCheck = report({
    verified: true, reasons: [], changedFiles: 1, changedPaths: ['a.java'],
    checks: checks({ changedFiles: ['a.java'] })
  });
  assert.equal(hasGenuineDelivery([noCheck]), false);
});


test('代码改动四项齐全才算完成：只有运行通过时 fullyVerified=false', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'hello-jwp/main.go' }, { path: 'hello-jwp/main.go' }),
    step('shell.run', 'completed', { exitCode: 0, stdout: 'hello jwp\n' }, { command: './hello' })
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.fullyVerified, false);
  assert.equal(outcome.checks.compile.status, 'skipped');
  assert.match(outcome.reasons.join('；'), /完成检查未齐全/);
  assert.equal(verificationIsComplete(outcome), false);
});

test('代码改动：编译/运行/测试/诊断四项都通过才算完成', () => {
  const outcome = verifyExecution([
    step('fs.writeFile', 'completed', { path: 'hello-jwp/main.go' }, { path: 'hello-jwp/main.go' }),
    step('shell.run', 'completed', { exitCode: 0 }, { command: 'go build -o hello main.go' }),
    step('shell.run', 'completed', { exitCode: 0, stdout: 'hello jwp\n' }, { command: './hello' }),
    step('shell.run', 'completed', { exitCode: 0, stdout: 'ok\n' }, { command: 'go test ./...' }),
    step('shell.run', 'completed', { exitCode: 0 }, { command: 'go vet ./...' })
  ]);
  assert.equal(outcome.checks.compile.status, 'passed');
  assert.equal(outcome.checks.run.status, 'passed');
  assert.equal(outcome.checks.tests.status, 'passed');
  assert.equal(outcome.checks.diagnostics.status, 'passed');
  assert.equal(outcome.verified, true);
  assert.equal(outcome.fullyVerified, true);
  assert.equal(verificationIsComplete(outcome), true);
});

test('旧报告没有 fullyVerified 时按 checks 现算，不把部分检查当完成', () => {
  const oldPartial = {
    verified: true,
    reasons: [],
    changedFiles: 1,
    changedPaths: ['hello-jwp/main.go'],
    checks: checks({ run: { status: 'passed' } })
  };
  assert.equal(verificationIsComplete(oldPartial), false);
  const oldFull = {
    ...oldPartial,
    checks: checks({
      compile: { status: 'passed' },
      run: { status: 'passed' },
      tests: { status: 'passed' },
      diagnostics: { status: 'passed', errors: 0, warnings: 0 }
    })
  };
  assert.equal(verificationIsComplete(oldFull), true);
});

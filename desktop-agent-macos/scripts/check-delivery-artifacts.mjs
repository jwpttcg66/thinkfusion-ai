/**
 * 交付清单：写文件只回路径+字节、编译只打印产物名时，也必须列得出改动与产物。
 *
 * Run with: npm run test:delivery-artifacts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectTaskView } from '../out-test/shared/task-view.js';
import { buildTaskConversation } from '../out-test/shared/task-conversation.js';

const events = [{
  type: 'report.ready', at: 1000, taskId: 't1', roundId: 'r1',
  report: {
    verification: {
      verified: true, reasons: [], changedFiles: 2,
      changedPaths: ['hello-jwp/README.md'],
      checks: { compile: { status: 'passed', output: 'target/hello-jwp.jar' }, run: { status: 'passed', output: 'hello jwp' } }
    },
    results: [
      { tool: 'fs.writeFile', result: { path: '/tmp/p/HelloJwp.java', created: false, replaced: true, bytes: 506 } },
      { tool: 'shell.run', result: { cwd: '/tmp/p', command: 'ls -l out/com/example', stdout: 'total 8\n-rw-r--r-- HelloJwp.class\n' } }
    ]
  }
}];

test('fs.writeFile 的路径与字节进改动清单，验证器 changedPaths 兜底补齐', () => {
  const view = projectTaskView(events);
  assert.equal(view.changes.length, 2);
  assert.deepEqual(view.changes[0], { path: '/tmp/p/HelloJwp.java', replaced: true, bytes: 506 });
  assert.deepEqual(view.changes[1], { path: 'hello-jwp/README.md' });
});

test('编译/运行命令打印的 class、jar 进工程产物清单', () => {
  const view = projectTaskView(events);
  assert.deepEqual(view.artifacts.map(item => item.path).sort(), [
    '/tmp/p/HelloJwp.class',
    'target/hello-jwp.jar'
  ]);
});

test('结论里写出真实产物数量，不把模型一句话当交付', () => {
  const entries = buildTaskConversation(events, {
    prompt: '写一个 java 工程', summary: '任务完成', status: 'completed'
  });
  const conclusion = entries.find(entry => entry.kind === 'conclusion');
  assert.ok(conclusion);
  assert.ok(conclusion.facts.includes('改动 2 个文件'));
  assert.ok(conclusion.facts.includes('目标物 4 个') || conclusion.facts.some(item => /目标物 \d+ 个/.test(item)));
  assert.ok(conclusion.deliverables?.some(path => /HelloJwp\.java/.test(path)));
  assert.ok(conclusion.deliverables?.some(path => /HelloJwp\.class/.test(path)));
});

test('多轮报告：最后一轮只有验证时，结论仍保留前轮写出的交付文件', () => {
  const multi = [
    {
      type: 'report.ready', at: 1000, taskId: 't1', roundId: 'r1',
      report: {
        status: 'completed',
        verification: {
          verified: false, reasons: ['诊断未跑'], changedFiles: 1,
          changedPaths: ['java-hello-demo/HelloWorld.java'],
          checks: { compile: { status: 'passed' }, tests: { status: 'skipped' }, diagnostics: { status: 'skipped' } }
        },
        results: [
          { tool: 'fs.mkdir', status: 'completed', result: { path: '/tmp/java-hello-demo', created: true } },
          { tool: 'fs.writeFile', status: 'completed', result: { path: '/tmp/java-hello-demo/HelloWorld.java', created: true, bytes: 120 } },
          { tool: 'shell.run', status: 'completed', result: { cwd: '/tmp/java-hello-demo', command: 'javac HelloWorld.java', stdout: '' } }
        ]
      }
    },
    {
      type: 'report.ready', at: 2000, taskId: 't1', roundId: 'r2',
      report: {
        status: 'completed',
        verification: {
          verified: true, reasons: [], changedFiles: 0, changedPaths: [],
          checks: { compile: { status: 'passed' }, run: { status: 'passed', output: 'Hello World' }, tests: { status: 'skipped' }, diagnostics: { status: 'skipped' } }
        },
        results: [
          { tool: 'shell.run', status: 'completed', result: { cwd: '/tmp/java-hello-demo', command: 'javac HelloWorld.java && java HelloWorld', stdout: 'Hello World\n' } }
        ]
      }
    },
    { type: 'task.completed', at: 2100, taskId: 't1', summary: '任务完成' }
  ];
  const entries = buildTaskConversation(multi, { prompt: '写 hello', status: 'completed' });
  const conclusion = entries.find(entry => entry.kind === 'conclusion');
  assert.ok(conclusion, '必须有结论卡');
  assert.ok(conclusion.deliverables?.some(path => /HelloWorld\.java/.test(path)),
    '前轮写出的源码不得被后轮空报告冲掉');
  assert.ok(conclusion.deliverables?.some(path => /java-hello-demo/.test(path)),
    '前轮创建的目录仍须在目标物里');
  assert.ok(conclusion.facts.some(item => /目标物 \d+ 个/.test(item)));
  assert.equal(conclusion.facts.includes('没有记录到交付文件'), false);
});

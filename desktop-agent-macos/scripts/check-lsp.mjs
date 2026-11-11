/**
 * TypeScript 语义导航：definition / references / hover / symbols / diagnostics。
 *
 * 用工程里自带的 tsserver（不引新依赖），在一个临时 TS 工程上验证：
 * 1. 调用点能跳到定义；2. references 同时含声明与调用；3. hover 有类型签名；
 * 4. navtree 能列出函数；5. 语义诊断能抓到类型错误。
 *
 * Run with: npm run test:lsp
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { TsServerClient } from '../out-test/main/lsp/tsserver.js';
import { LspProviderRegistry, TypeScriptProvider } from '../out-test/main/lsp/providers.js';
import { buildCodeContext } from '../out-test/main/lsp/context.js';
import { buildImpact } from '../out-test/main/lsp/impact.js';
import { loadTypeScript, summarizeAst } from '../out-test/main/lsp/ts-ast.js';
import { localCapabilities } from '../out-test/agent/local-plugins.js';

const root = mkdtempSync(join(tmpdir(), 'tf-lsp-'));
after(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noEmit: true },
  include: ['src']
}, null, 2));
writeFileSync(join(root, 'src', 'a.ts'), [
  'export function greet(name: string): string {',
  "  return `hi ${name}`;",
  '}'
].join('\n'));
writeFileSync(join(root, 'src', 'b.ts'), [
  "import { greet } from './a';",
  "const text = greet('world');",
  'console.log(text);'
].join('\n'));
writeFileSync(join(root, 'src', 'a.test.ts'), [
  "import { greet } from './a';",
  "test('greet', () => { greet('x'); });"
].join('\n'));
writeFileSync(join(root, 'src', 'broken.ts'), [
  "const n: number = 'not-a-number';",
  'export { n };'
].join('\n'));

const tsserver = resolve('node_modules/typescript/lib/tsserver.js');
const client = new TsServerClient(root, tsserver);
after(() => client.dispose());

test('definition：从调用点回到定义', async () => {
  const locations = await client.definition({ file: join(root, 'src', 'b.ts'), line: 2, character: 14 });
  assert.ok(locations.length > 0, '至少要有一个定义位置');
  assert.equal(locations[0].path, 'src/a.ts');
  assert.equal(locations[0].line, 1);
});

test('references：同时包含声明和调用', async () => {
  const locations = await client.references({ file: join(root, 'src', 'a.ts'), line: 1, character: 17 });
  const paths = locations.map(item => `${item.path}:${String(item.line)}`);
  assert.ok(paths.includes('src/a.ts:1'), '必须包含声明处');
  assert.ok(paths.some(item => item.startsWith('src/b.ts:')), '必须包含调用处');
});

test('hover：返回函数签名', async () => {
  const hover = await client.hover({ file: join(root, 'src', 'b.ts'), line: 2, character: 14 });
  assert.ok(hover, 'hover 不应为空');
  assert.match(hover.display, /greet/);
});

test('symbols：navtree 列出函数', async () => {
  const symbols = await client.symbols(join(root, 'src', 'a.ts'));
  assert.ok(symbols.some(item => item.name === 'greet' && item.line === 1));
});

test('diagnostics：语义检查抓到类型错误', async () => {
  const issues = await client.diagnostics(join(root, 'src', 'broken.ts'));
  assert.ok(issues.length > 0, '必须有诊断');
  assert.equal(issues[0].path, 'src/broken.ts');
  assert.match(issues[0].message, /not assignable|不能将|不可分配|number/i);
});

test('工具转发到主进程时注入授权根，模型不能自己换根', async () => {
  const calls = [];
  const grant = {
    taskId: 'task-lsp-bridge',
    permissionPreset: 'read-only',
    approvalPolicy: 'ask',
    rootDir: root,
    allowedTools: ['code.definition', 'code.references', 'code.symbols', 'code.hover'],
    expiresAt: Date.now() + 60_000,
    maxSteps: 30,
    grantVersion: 1
  };
  const outcome = await localCapabilities.execute(
    'code.definition',
    { path: 'src/a.ts', line: 1, character: 17, root: '/etc' },
    { grant, callMain: async (id, args) => { calls.push({ id, args }); return []; } }
  );
  assert.equal(outcome.error ?? null, null, String(outcome.error ?? ''));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'code.definition');
  assert.equal(calls[0].args.root, root, 'root 必须来自 grant，不能被模型参数覆盖');
  assert.equal(calls[0].args.path, 'src/a.ts');
});

test('写之后自动带诊断：结果里能看到错误数与位置', async () => {
  const calls = [];
  const grant = {
    taskId: 'task-lsp-postwrite',
    permissionPreset: 'workspace-write',
    approvalPolicy: 'ask',
    rootDir: root,
    allowedTools: ['fs.edit', 'code.diagnostics.lsp'],
    expiresAt: Date.now() + 60_000,
    maxSteps: 30,
    grantVersion: 1
  };
  const before = readFileSync(join(root, 'src/a.ts'), 'utf8');
  const outcome = await localCapabilities.execute(
    'fs.edit',
    {
      path: 'src/a.ts',
      oldString: 'export function greet',
      newString: 'export function greet',
      expectedHash: createHash('sha256').update(before).digest('hex')
    },
    {
      grant,
      callMain: async (id, args) => {
        calls.push({ id, args });
        if (id === 'code.diagnostics.lsp') {
          return {
            source: 'tsserver',
            issues: [{ path: 'src/a.ts', line: 1, column: 1, severity: 'error', message: 'TS2322 示例', source: 'tsserver' }],
            counts: { errors: 1, warnings: 0 }
          };
        }
        return null;
      }
    }
  );
  assert.equal(outcome.error ?? null, null, String(outcome.error ?? ''));
  const diagnostics = outcome.result.diagnostics;
  assert.ok(diagnostics, '写后诊断必须挂在结果里');
  assert.equal(diagnostics.counts.errors, 1);
  assert.equal(diagnostics.issues[0].message, 'TS2322 示例');
  const check = calls.find(item => item.id === 'code.diagnostics.lsp');
  assert.equal(check.args.root, root);
  assert.equal(check.args.path, 'src/a.ts');
});

test('ContextBuilder：符号 / 定义 / 引用 / hover / 候选测试都带来源', async () => {
  const pack = await buildCodeContext(
    client,
    root,
    join(root, 'src', 'a.ts'),
    { line: 1, character: 17 },
    50
  );
  assert.equal(pack.source, 'tsserver');
  assert.equal(pack.file, 'src/a.ts');
  assert.ok(pack.symbols.some(item => item.name === 'greet'));
  assert.ok(pack.references.some(item => item.path === 'src/b.ts'));
  assert.ok(pack.hover && /greet/.test(pack.hover.display));
  assert.match(pack.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.ok((pack.totalLines ?? 0) >= 3);
  assert.ok(Array.isArray(pack.relatedTests));
});

test('影响分析：引用分成调用与引用，调用标 EXACT，测试是候选', async () => {
  const cacheDir = mkdtempSync(join(root, '.cache-'));
  const pack = await buildImpact(client, root, join(root, 'src', 'a.ts'), { line: 1, character: 17 }, cacheDir);
  assert.equal(pack.source, 'tsserver+typescript-ast');
  const bRelations = pack.relations.filter(item => item.path === 'src/b.ts');
  assert.ok(bRelations.length > 0, 'b.ts 必须在关系里');
  assert.ok(bRelations.some(item => item.kind === 'call' && item.confidence === 'EXACT'), '调用点要标成 EXACT call');
  assert.ok(bRelations.some(item => item.kind === 'reference'), 'import 那处只是引用');
  assert.ok(pack.relatedTests.some(item => item.path === 'src/a.test.ts'), '测试文件要作为候选列出');
  assert.equal(pack.relatedTests[0].confidence, 'POSSIBLE');
});

test('影响分析结果按文件 mtime 缓存，第二次直接命中', async () => {
  const cacheDir = mkdtempSync(join(root, '.cache-hit-'));
  await buildImpact(client, root, join(root, 'src', 'a.ts'), { line: 1, character: 17 }, cacheDir);
  const second = await buildImpact(client, root, join(root, 'src', 'a.ts'), { line: 1, character: 17 }, cacheDir);
  assert.equal(second.cached, true);
});

test('按需 AST：列出声明与调用点', async () => {
  const ts = await loadTypeScript();
  assert.ok(ts, '本机应能找到 typescript');
  const text = readFileSync(join(root, 'src', 'a.ts'), 'utf8');
  const summary = summarizeAst(ts, join(root, 'src', 'a.ts'), text);
  assert.equal(summary.source, 'typescript-ast');
  assert.ok(summary.declarations.some(item => item.name === 'greet'));
});


test('Provider 层：TypeScript 有客户端，其他语言明确 LSP_UNAVAILABLE', () => {
  const registry = new LspProviderRegistry([new TypeScriptProvider([tsserver])]);
  assert.equal(registry.providerFor(join(root, 'src/a.ts'))?.id, 'typescript');
  assert.equal(registry.providerFor(join(root, 'src/a.py')), null);
  assert.match(registry.unavailableReason('a.py'), /LSP_UNAVAILABLE/);
  assert.ok(registry.get(root, join(root, 'src/a.ts')));
  assert.equal(registry.get(root, join(root, 'src/a.py')), null);
  registry.dispose();
});

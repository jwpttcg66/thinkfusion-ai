/**
 * Gate 0 spike：在 Electron 主进程里加载 Tree-sitter Java grammar。
 *
 * 这不是产品代码，不初始化窗口、不读数据库；只证明：
 *   - Electron 45 / Node 24 能初始化 web-tree-sitter；
 *   - grammar 的 ABI 与运行时兼容；
 *   - 从磁盘读 `.wasm` 再交给 `Language.load()` 的路径可行；
 *   - 同样的读法在 asar 内也可行（`fs.readFileSync` 会走 Electron 的 asar 补丁）。
 *
 * 运行：
 *   npm run spike:tree-sitter:electron
 *   npm run spike:tree-sitter:electron -- --asar
 *
 * 打包后的 asar 不能直接用 `fetch()` 读 `.wasm`；正式接入时要么把
 * grammar 放进 `asarUnpack`，要么在包内用 `fs.readFileSync()` 读成
 * Uint8Array 再加载。这个脚本两种路径都验证。
 */

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');

const sourceWasm = path.join(
  __dirname,
  '..',
  '..',
  'node_modules',
  '@vscode',
  'tree-sitter-wasm',
  'wasm',
  'tree-sitter-java.wasm'
);

async function loadFrom(buffer, source) {
  const { Parser, Language } = require('web-tree-sitter');
  await Parser.init();
  const language = await Language.load(buffer);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse('package demo; class A { void f() { g(); } }');
  const ok = Boolean(tree) && !tree.rootNode.hasError;
  return {
    source,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    grammarAbi: language.abiVersion,
    root: tree?.rootNode.type ?? null,
    hasError: tree?.rootNode.hasError ?? null,
    ok
  };
}

app.whenReady().then(async () => {
  const results = [await loadFrom(fs.readFileSync(sourceWasm), 'disk')];

  if (process.argv.includes('--asar')) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ts-asar-'));
    const src = path.join(temp, 'src');
    fs.mkdirSync(src);
    fs.copyFileSync(sourceWasm, path.join(src, 'tree-sitter-java.wasm'));
    const archive = path.join(temp, 'app.asar');
    await asar.createPackage(src, archive);
    results.push(await loadFrom(fs.readFileSync(path.join(archive, 'tree-sitter-java.wasm')), 'asar'));
  }

  for (const result of results) console.log(JSON.stringify(result));
  app.exit(results.every(result => result.ok) ? 0 : 1);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

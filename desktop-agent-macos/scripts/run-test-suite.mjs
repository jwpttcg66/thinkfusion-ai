/**
 * 全量测试统一入口：编译一次，所有测试文件一次跑完。
 *
 * 原来的 `npm test` 是 96 个 `npm run test:X` 串行，每个套件都先
 * `tsc -p tsconfig.test.json` 全量编译一遍——约 90 次重复编译占了
 * 绝大多数时间，6 分钟跑不完。这里只做一件事：从 `scripts.test:all` 链里
 * 解析出它实际会跑的每一个测试文件（不改名单、不加不减），编译交给
 * 前置步骤，然后一次 `node --test` 并发跑完；再补上两个不走
 * `node --test` 的直跑脚本。链上加了新套件，这里自动跟上。
 *
 * 按需跑单个套件仍然用各自的 `npm run test:X`，行为不变。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

/** 从 `scripts.test:all` 链解析出全部测试文件；链的写法变了就明确报错，不悄悄漏跑。 */
function collectTestFiles() {
  const chain = pkg.scripts['test:all'];
  if (!chain) throw new Error('package.json 里没有 test:all——全量测试的名单来源丢了');
  const steps = chain.split('&&').map(item => item.trim());
  const testFiles = new Set();
  const plainFiles = new Set();
  for (const step of steps) {
    if (!step.startsWith('npm run test:')) {
      throw new Error(`test 链里出现了不认识的步骤：${step}`);
    }
    const name = step.slice('npm run '.length).trim();
    const impl = pkg.scripts[name];
    if (!impl) throw new Error(`test 链引用了不存在的脚本：${name}`);
    for (const segment of impl.split('&&').map(item => item.trim())) {
      if (segment.startsWith('npm run')) continue; // 编译步骤，入口已统一做过
      if (segment.startsWith('node --test')) {
        segment
          .split(/\s+/)
          .slice(2)
          .filter(arg => !arg.startsWith('--'))
          .forEach(file => testFiles.add(file));
      } else if (segment.startsWith('node ')) {
        plainFiles.add(segment.split(/\s+/)[1]);
      } else {
        throw new Error(`${name} 里有没接住的命令形态：${segment}`);
      }
    }
  }
  return { testFiles: [...testFiles], plainFiles: [...plainFiles] };
}

const { testFiles, plainFiles } = collectTestFiles();

// 并发数可以压：默认用一半核数，避免终端/CLI 这类起子进程的套件互相踩端口。
const concurrency = Math.max(2, Math.floor(availableParallelism() / 2));

console.log(`全量测试：${testFiles.length} 个 node:test 文件（并发 ${concurrency}）+ ${plainFiles.length} 个直跑脚本`);
const started = Date.now();

// --test-force-exit 全局带上：个别套件（终端 / CLI）会留子进程，原链里就是
// 这几个文件带这个旗标，对其余套件无害（测试结束才兜底强制退出）。
const runner = spawnSync(
  'node',
  ['--test', '--test-force-exit', `--test-concurrency=${concurrency}`, ...testFiles],
  { stdio: 'inherit' }
);
if (runner.status !== 0) {
  console.error(`\nnode --test 失败（exit ${runner.status}），直跑脚本不再继续。`);
  process.exit(runner.status ?? 1);
}

let failed = 0;
for (const file of plainFiles) {
  const result = spawnSync('node', [file], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${file} 失败（exit ${result.status}）`);
    failed += 1;
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed > 0) {
  console.error(`\n全量测试未通过：${failed} 个直跑脚本失败（${seconds}s）`);
  process.exit(1);
}
console.log(`\n全量测试通过：${testFiles.length + plainFiles.length} 个文件（${seconds}s）`);

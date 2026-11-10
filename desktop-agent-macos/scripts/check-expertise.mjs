/**
 * 专家与技能的行为测试。
 *
 * 要钉住五件事：
 * 1. 文件——frontmatter 能读、用户能覆盖、写坏了明确报错而不是静默退回内置；
 * 2. 场景——只有设计 / 实施 / 改造类问题才加载技能，读数 / 查事实 / 定位报错
 *    一律不加载（这几条是 s20/s21/s24 真机验收过的本地读文件能力）；
 * 3. 边界——知识空间返回空、只追加 system、question 保持用户原话、网页不碰；
 * 4. 开关——停用落盘，重启读回；
 * 5. 防回归——不复活固定提示词模块，注入点只有一处，设置页真的列出清单。
 *
 * Run with: npm run test:expertise
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPERTISE_IDS,
  expertiseFallback,
  isExpertiseId,
  normalizeExpertiseDisabled
} from '../out-test/shared/expertise.js';
import { parseFrontmatter } from '../out-test/main/expertise/frontmatter.js';
import { loadExpertise, describeExpertise } from '../out-test/main/expertise/loader.js';
import { shouldLoadEngineeringSkill } from '../out-test/main/expertise/trigger.js';
import { buildEngineeringExpertise } from '../out-test/main/expertise/system.js';
import { ExpertiseStore } from '../out-test/main/expertise/store.js';
import { buildEngineeringAnswerQuestion, engineeringAnswerSystem } from '../out-test/main/research/engineering-round.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILTIN = join(ROOT, 'resources', 'expertise');
const work = mkdtempSync(join(tmpdir(), 'tf-expertise-'));
after(() => rmSync(work, { recursive: true, force: true }));

const source = rel => readFileSync(join(ROOT, 'src', rel), 'utf8');
const builtin = () => loadExpertise({ builtinDirs: [BUILTIN], userDir: join(work, 'no-user-files') });
const build = (state, workspaceMode, question, disabled = []) =>
  buildEngineeringExpertise({ state, workspaceMode, question, disabled });

// ---------------------------------------------------------------------------
// 1. 文件
// ---------------------------------------------------------------------------

test('内置两份 .md 都在，frontmatter 与正文都读得到', () => {
  assert.ok(existsSync(join(BUILTIN, 'EXPERT.md')));
  assert.ok(existsSync(join(BUILTIN, 'skills', 'engineering-design', 'SKILL.md')));
  const state = builtin();
  assert.match(state.expert.body, /高级开发工程师/);
  assert.equal(state.expert.meta.id, 'senior-developer');
  assert.equal(state.expert.source, 'builtin');
  assert.equal(state.expert.error, undefined);
  assert.match(state.skill.body, /Phase 1/);
  assert.match(state.skill.meta.doNotTrigger, /多少行/);
  assert.equal(state.skill.meta.version, '1.0.0');
  const views = describeExpertise(state, []);
  assert.deepEqual(views.map(v => v.id), [...EXPERTISE_IDS]);
  assert.ok(views.every(v => v.chars > 0 && !v.error && v.enabled && v.source === 'builtin'));
  assert.ok(views.every(v => v.filePath.endsWith('.md') && v.userPath.endsWith('.md')));
});

test('frontmatter：块标量、折叠、引号、注释、嵌套都不炸', () => {
  const parsed = parseFrontmatter(
    [
      '---',
      'name: demo',
      'title: "我的技能"',
      '# 注释行',
      'description: |',
      '  第一行',
      '  第二行',
      'trigger: >',
      '  设计',
      '  实施',
      'metadata:',
      '  category: engineering',
      '---',
      '',
      '# 正文',
      '内容'
    ].join('\n')
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.name, 'demo');
  assert.equal(parsed.fields.title, '我的技能');
  assert.equal(parsed.fields.description, '第一行\n第二行');
  assert.equal(parsed.fields.trigger, '设计 实施');
  assert.equal(parsed.fields.metadata, '');
  assert.equal(parsed.fields.category, undefined);
  assert.equal(parsed.body, '# 正文\n内容');
});

test('没有 --- 包裹就不算一份技能文件', () => {
  const parsed = parseFrontmatter('# 只是正文\n没有 frontmatter');
  assert.equal(parsed.ok, false);
  assert.match(parsed.body, /只是正文/);
});

test('用户放同名文件就覆盖内置，来源标成 user', () => {
  const userDir = join(work, 'override');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'EXPERT.md'),
    ['---', 'name: senior-developer', 'title: 我自己的专家', 'version: 9.9.9', '---', '', '自定义人设正文'].join('\n')
  );
  const state = loadExpertise({ builtinDirs: [BUILTIN], userDir });
  assert.equal(state.expert.source, 'user');
  assert.equal(state.expert.meta.title, '我自己的专家');
  assert.equal(state.expert.meta.version, '9.9.9');
  assert.match(state.expert.body, /自定义人设正文/);
  // 技能没被覆盖，仍读内置。
  assert.equal(state.skill.source, 'builtin');
});

test('用户文件写坏了：明确报错、不注入，也不静默退回内置', () => {
  const userDir = join(work, 'broken');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'EXPERT.md'), '没有 frontmatter 的一段字');
  const state = loadExpertise({ builtinDirs: [BUILTIN], userDir });
  assert.match(state.expert.error, /frontmatter/);
  assert.equal(state.expert.body, '');
  assert.equal(state.expert.chars, 0);
  assert.equal(build(state, 'engineering', '设计一个接口', []).loaded.includes('senior-developer'), false);
});

test('空正文 / 超长正文 / 找不到文件，各有明确原因', () => {
  const userDir = join(work, 'empty');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'EXPERT.md'), '---\nname: e\n---\n\n');
  assert.match(loadExpertise({ builtinDirs: [BUILTIN], userDir }).expert.error, /正文是空的/);

  writeFileSync(join(userDir, 'EXPERT.md'), `---\nname: e\n---\n\n${'字'.repeat(21000)}`);
  assert.match(loadExpertise({ builtinDirs: [BUILTIN], userDir }).expert.error, /超过/);

  const missing = loadExpertise({ builtinDirs: [join(work, 'nothing')], userDir: join(work, 'nothing') });
  assert.match(missing.expert.error, /没找到/);
  assert.match(missing.skill.error, /没找到/);
});

// ---------------------------------------------------------------------------
// 2. 场景判定（最重要：保护本地读文件能力）
// ---------------------------------------------------------------------------

test('读数 / 统计 / 定位报错一律不加载技能', () => {
  const questions = [
    '读取这个文件告诉我总共有多少行',
    '文件里出现了多少次 stream',
    '那个文件里面对标签进行统计',
    '这个函数为什么报错，在第几行',
    '帮我看看这个文件有多少行，顺便问问网页',
    '查一下 config.json 里有没有 timeout'
  ];
  for (const question of questions) {
    assert.equal(shouldLoadEngineeringSkill(question).load, false, question);
  }
});

test('设计 / 实施 / 改造 / 修 bug / 决策取舍会加载技能', () => {
  const questions = [
    '帮我设计一个 REST API',
    '实现这个模块的缓存层',
    '重构一下 conversation-runner',
    '怎么修这个 bug',
    '要不要把 session 存到 SQLite',
    '对比 SQLite 和 DuckDB 在单机应用里的取舍'
  ];
  for (const question of questions) {
    const hit = shouldLoadEngineeringSkill(question);
    assert.equal(hit.load, true, `${question} → ${hit.reason}`);
    assert.ok(hit.reason.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 3. 边界
// ---------------------------------------------------------------------------

test('知识空间一个字都不注入', () => {
  const state = builtin();
  for (const question of ['设计一个接口', '这个文件多少行']) {
    const result = build(state, 'knowledge', question, []);
    assert.deepEqual(result.system, []);
    assert.deepEqual(result.loaded, []);
    assert.equal(result.note, '');
  }
  assert.deepEqual(build(state, undefined, '设计一个接口', []).system, []);
});

test('工程空间：专家常驻，技能按场景加载', () => {
  const state = builtin();
  // 按行首判断：专家正文里也提到「【本次加载的技能】」这个词，子串会误判。
  const has = (result, title) => result.system.some(line => line.startsWith(`【${title}】`));
  const reading = build(state, 'engineering', '这个文件多少行', []);
  assert.deepEqual(reading.loaded, ['senior-developer']);
  assert.equal(has(reading, '当前专家'), true);
  assert.equal(has(reading, '本次加载的技能'), false);
  assert.equal(reading.note, '');

  const designing = build(state, 'engineering', '帮我设计一个接口', []);
  assert.deepEqual(designing.loaded, ['senior-developer', 'engineering-design']);
  assert.equal(has(designing, '本次加载的技能'), true);
  assert.match(designing.note, /已加载技能/);
});

test('停用一个只影响它自己，两项都停用就是老行为', () => {
  const state = builtin();
  const noSkill = build(state, 'engineering', '设计一个接口', ['engineering-design']);
  assert.deepEqual(noSkill.loaded, ['senior-developer']);
  assert.equal(noSkill.note, '');

  const noExpert = build(state, 'engineering', '设计一个接口', ['senior-developer']);
  assert.deepEqual(noExpert.loaded, ['engineering-design']);

  const neither = build(state, 'engineering', '设计一个接口', [...EXPERTISE_IDS]);
  assert.deepEqual(neither.system, []);
  assert.equal(neither.note, '');
});

test('文件坏了不注入也不崩', () => {
  const userDir = join(work, 'broken2');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'EXPERT.md'), 'bad');
  mkdirSync(join(userDir, 'skills', 'engineering-design'), { recursive: true });
  writeFileSync(join(userDir, 'skills', 'engineering-design', 'SKILL.md'), 'bad');
  const state = loadExpertise({ builtinDirs: [BUILTIN], userDir });
  const result = build(state, 'engineering', '设计一个接口', []);
  assert.deepEqual(result.system, []);
  assert.match(describeExpertise(state, []).find(v => v.id === 'senior-developer').error, /frontmatter/);
});

test('防回归：question 仍是用户原话 + 证据，基础 system 不含专家或技能', () => {
  const question = '设计一个接口';
  const material = '【工程证据】\n/a.ts:1';
  const asked = buildEngineeringAnswerQuestion(question, material);
  assert.ok(asked.startsWith('【用户的问题】\n设计一个接口'));
  assert.ok(!asked.includes('高级开发工程师'));
  assert.ok(!asked.includes('【本次加载的技能】'));
  assert.ok(!asked.includes('Phase 1'));
  const base = engineeringAnswerSystem();
  assert.equal(base.length, 3);
  assert.ok(base.join('\n').includes('只依据这些证据回答'));
  assert.ok(!base.join('\n').includes('高级开发工程师'));
});

test('防回归：注入点只有一处，且只追加到 system；无证据时不加载', () => {
  const runner = source('main/conversation-runner.ts');
  assert.equal((runner.match(/\.\.\.expertise\.system/g) || []).length, 1);
  // 有工程证据 / 附件时才拼专家；常识题走空 system，避免「无法确定」纪律污染选型题。
  assert.match(
    runner,
    /const summarySystem = needsLocalRead\s*\?\s*\[\.\.\.engineeringAnswerSystem\(\{ attachments: attachmentCount \}\), \.\.\.expertise\.system\]\s*:\s*\[\]/
  );
  assert.match(runner, /const expertise = needsLocalRead/);
  assert.match(runner, /question: engineered/);
  assert.ok(!runner.includes('expertise.question'));
  assert.ok(!runner.includes('buildLeadSummaryQuestion(..., expertise'));
  assert.equal(existsSync(join(ROOT, 'src', 'shared', 'prompts.ts')), false);
});

test('防回归：设置页真的列出专家与技能，且写明它不是 agent', () => {
  const panel = source('renderer/src/components/SettingsPanel.tsx');
  assert.ok(panel.includes("id: 'expertise'"));
  assert.ok(panel.includes('getExpertise()'));
  assert.ok(panel.includes('setExpertiseEnabled(id, enabled)'));
  assert.ok(panel.includes('EXPERTISE_KIND_LABELS'));
  assert.ok(panel.includes('它们不是新的 agent'));
  const preload = source('preload/index.ts');
  assert.ok(preload.includes("ipcRenderer.invoke('expertise:list')"));
  assert.ok(preload.includes("ipcRenderer.invoke('expertise:set'"));
});

// ---------------------------------------------------------------------------
// 4. 开关与清单契约
// ---------------------------------------------------------------------------

test('开关落盘、重启读回、不认识的 id 拒绝', () => {
  const file = join(work, 'expertise.json');
  const store = new ExpertiseStore(file);
  assert.deepEqual(store.disabledIds(), []);
  assert.deepEqual(store.setEnabled('engineering-design', false), ['engineering-design']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).disabled[0], 'engineering-design');
  assert.deepEqual(new ExpertiseStore(file).disabledIds(), ['engineering-design']);
  assert.deepEqual(store.setEnabled('engineering-design', true), []);
  assert.throws(() => store.setEnabled('not-a-thing', false), /没有这个专家或技能/);
});

test('清单契约：两个 id、类型与停用列表归一化', () => {
  assert.deepEqual([...EXPERTISE_IDS], ['senior-developer', 'engineering-design']);
  assert.equal(expertiseFallback('senior-developer').kind, 'expert');
  assert.equal(expertiseFallback('engineering-design').kind, 'skill');
  assert.equal(isExpertiseId('senior-developer'), true);
  assert.equal(isExpertiseId('web.search'), false);
  assert.deepEqual(
    normalizeExpertiseDisabled(['senior-developer', 'nope', 'senior-developer']),
    ['senior-developer']
  );
  assert.deepEqual(normalizeExpertiseDisabled(null), []);
});

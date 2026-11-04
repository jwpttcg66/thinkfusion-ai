/**
 * Behaviour tests for editable sources.
 *
 * This is the feature that lets a URL be changed from the UI, so the rules being
 * pinned here are the ones that keep a saved address from becoming a broken
 * app: a bad address is refused rather than stored, an edit never widens the
 * allow-list beyond the site the user named, the last remaining source cannot be
 * switched off because the agent would have nowhere to ask, and a corrupt
 * settings file degrades to the shipped defaults instead of an empty rail.
 *
 * Run with: npm run test:sources-config
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BUILTIN_SOURCES,
  isAllowedSourceUrl,
  makeCustomSource,
  normalizeSourceUrl,
  planningSource,
  resolveSources,
  sourceById
} from '../out-test/shared/sources.js';
import { SourceStore } from '../out-test/main/source-store.js';
import { SubAgentRegistry } from '../out-test/main/agents/registry.js';
import { PROVIDERS } from '../out-test/main/adapters/providers/index.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sources-')), 'sources.json');

test('the shipped defaults are the five providers, and only one is on', () => {
  assert.deepEqual(
    BUILTIN_SOURCES.map(source => source.id),
    ['deepseek', 'chatgpt', 'kimi', 'gemini', 'workbuddy']
  );
  // One live channel, so a fresh install has somewhere to ask and does not
  // pre-load sites (or accounts) the user did not choose.
  assert.deepEqual(
    BUILTIN_SOURCES.filter(source => source.enabled).map(source => source.id),
    ['chatgpt']
  );
  // The planning flag survives on a source that ships off; see the pool below.
  assert.equal(sourceById(BUILTIN_SOURCES, 'deepseek').planning, true);
});

test('an untouched list is the defaults, in the shipped order', () => {
  const resolved = resolveSources();
  assert.deepEqual(resolved.map(source => source.id), ['deepseek', 'chatgpt', 'kimi', 'gemini', 'workbuddy']);
  assert.equal(resolved[0].url, 'https://chat.deepseek.com/');
});

test('a saved URL replaces the default and adds its host', () => {
  const resolved = resolveSources({ overrides: { kimi: { url: 'https://kimi.com/chat' } }, custom: [] });
  const kimi = sourceById(resolved, 'kimi');
  assert.equal(kimi.url, 'https://kimi.com/chat');
  // The declared hosts stay: they are what makes an OAuth hop work.
  assert.ok(kimi.hosts.includes('kimi.moonshot.cn'));
  assert.ok(kimi.hosts.includes('kimi.com'));
});

test('the edited URL is allowed even though it was not in the shipped list', () => {
  const resolved = resolveSources({ overrides: { deepseek: { url: 'https://chat.deepseek.com.cn/' } }, custom: [] });
  const deepseek = sourceById(resolved, 'deepseek');
  assert.equal(isAllowedSourceUrl(deepseek, 'https://chat.deepseek.com.cn/a'), true);
  assert.equal(isAllowedSourceUrl(deepseek, 'https://evil.example.com/'), false);
});

test('a sub-domain that merely ends with the host is still refused', () => {
  const deepseek = sourceById(resolveSources(), 'deepseek');
  assert.equal(isAllowedSourceUrl(deepseek, 'https://evil-chat.deepseek.com/'), false);
});

test('enabling a source does not touch the planning flag', () => {
  const resolved = resolveSources({ overrides: { kimi: { enabled: true } }, custom: [] });
  assert.equal(sourceById(resolved, 'kimi').enabled, true);
  assert.equal(sourceById(resolved, 'kimi').planning, false);
  // kimi carries no planning flag, so the planner stays the first source that
  // is on — which, with DeepSeek off by default, is ChatGPT.
  assert.equal(planningSource(resolved).id, 'chatgpt');
});

test('turning the flagged source on makes it the planner again', () => {
  assert.equal(planningSource(resolveSources()).id, 'chatgpt');

  const resolved = resolveSources({ overrides: { deepseek: { enabled: true } }, custom: [] });
  assert.equal(planningSource(resolved).id, 'deepseek');
  assert.equal(planningSource(resolved).planning, true);
});

test('with everything off there is no planner at all — which is why one has to stay on', () => {
  const resolved = resolveSources({ overrides: { deepseek: { enabled: false }, chatgpt: { enabled: false } }, custom: [] });
  assert.equal(planningSource(resolved), undefined);
});

test('normalizeSourceUrl adds https, and refuses what it cannot use', () => {
  assert.deepEqual(normalizeSourceUrl('kimi.com'), { ok: true, url: 'https://kimi.com/' });
  assert.deepEqual(normalizeSourceUrl('  https://a.example.com/x  '), { ok: true, url: 'https://a.example.com/x' });
  assert.equal(normalizeSourceUrl('').ok, false);
  assert.equal(normalizeSourceUrl('http://a.example.com/').ok, false);
  assert.equal(normalizeSourceUrl('https://user:pw@a.example.com/').ok, false);
  assert.equal(normalizeSourceUrl('https://localhost/').ok, false);
  assert.equal(normalizeSourceUrl('not a url').ok, false);
});

test('a custom source gets an id, a glyph and its own host', () => {
  const created = makeCustomSource({ label: 'Kimi', url: 'https://kimi.com/' }, resolveSources());
  assert.equal(created.id, 'custom-kimi');
  assert.equal(created.glyph, 'K');
  assert.deepEqual(created.hosts, ['kimi.com']);
  assert.equal(created.enabled, true);
  assert.equal(created.custom, true);
});

test('a second custom source with the same name gets a distinct id', () => {
  const first = makeCustomSource({ label: 'Kimi', url: 'https://a.example.com/' }, resolveSources());
  const second = makeCustomSource({ label: 'Kimi', url: 'https://b.example.com/' }, [...resolveSources(), first]);
  assert.equal(second.id, 'custom-kimi-2');
});

test('custom sources come after the built-ins and can be disabled like any other', () => {
  const custom = makeCustomSource({ label: 'Mine', url: 'https://mine.example.com/' }, resolveSources());
  const resolved = resolveSources({ overrides: { [custom.id]: { enabled: false } }, custom: [custom] });
  assert.deepEqual(resolved.map(source => source.id).slice(-1), ['custom-mine']);
  assert.equal(sourceById(resolved, 'custom-mine').enabled, false);
});

test('the store round-trips an edit', () => {
  const file = tmpFile();
  const store = new SourceStore(file);
  store.patch('kimi', { url: 'https://kimi.com/', enabled: true });
  const reloaded = new SourceStore(file);
  assert.deepEqual(reloaded.all().overrides.kimi, { url: 'https://kimi.com/', enabled: true });
});

test('clearing both fields removes the override rather than storing nulls', () => {
  const file = tmpFile();
  const store = new SourceStore(file);
  store.patch('kimi', { enabled: true });
  store.patch('kimi', { enabled: undefined });
  assert.equal(store.all().overrides.kimi, undefined);
});

test('a stored URL that no longer normalizes is dropped, not carried forward', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ overrides: { kimi: { url: 'http://insecure.example.com/' } }, custom: [] }));
  const store = new SourceStore(file);
  assert.equal(store.all().overrides.kimi, undefined);
});

test('a corrupt file degrades to the shipped defaults', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json');
  const store = new SourceStore(file);
  assert.deepEqual(store.all(), { overrides: {}, custom: [] });
  assert.deepEqual(resolveSources(store.all()).map(source => source.id), BUILTIN_SOURCES.map(source => source.id));
});

// --------------------------------------------------------------- 保存就是承诺
//
// The promise 保存 makes is not "the running app remembers", it is "the next
// launch remembers". These four tests are that promise, at the only layer that
// can keep it: the file.

test('a custom source added through the store is there after a reopen', () => {
  const file = tmpFile();
  const store = new SourceStore(file);
  store.addCustom(makeCustomSource({ label: 'Mine', url: 'https://mine.example.com/' }, resolveSources()));
  const reopened = new SourceStore(file);
  const custom = reopened.all().custom;
  assert.equal(custom.length, 1);
  assert.equal(custom[0].id, 'custom-mine');
  assert.equal(custom[0].url, 'https://mine.example.com/');
  // And it resolves into the live list, with its own host allowed.
  const live = resolveSources(reopened.all());
  assert.equal(live.at(-1).label, 'Mine');
  assert.equal(isAllowedSourceUrl(live.at(-1), 'https://mine.example.com/chat'), true);
});

test('a switch that was turned off is still off after a reopen', () => {
  const file = tmpFile();
  const store = new SourceStore(file);
  store.patch('deepseek', { enabled: false });
  store.patch('chatgpt', { enabled: false });
  store.patch('kimi', { enabled: true });
  const reopened = new SourceStore(file);
  const live = resolveSources(reopened.all());
  assert.equal(sourceById(live, 'deepseek').enabled, false);
  assert.equal(sourceById(live, 'kimi').enabled, true);
  // The planner followed the switch, and it still follows it on the next boot.
  assert.equal(planningSource(live).id, 'kimi');
});

test('a write leaves no temp file and one known-good copy', () => {
  const file = tmpFile();
  const store = new SourceStore(file);
  store.patch('kimi', { url: 'https://kimi.com/' });
  const leftovers = fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.ok(fs.existsSync(`${file}.bak`), 'the previous copy should be kept');
});

test('a write that cannot land throws, and the file on disk is untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-'));
  const file = path.join(dir, 'sources.json');
  const store = new SourceStore(file);
  store.patch('kimi', { url: 'https://kimi.com/' });
  const before = fs.readFileSync(file, 'utf8');

  // A directory without write permission is the honest simulation: the file is
  // readable, and creating the temp file next to it fails.
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => store.patch('kimi', { url: 'https://kimi.com/chat' }), /重启后会丢/);
  } finally {
    fs.chmodSync(dir, 0o700);
  }

  // Memory must not claim what the disk refused.
  assert.equal(store.all().overrides.kimi.url, 'https://kimi.com/');
  // And the file that is there still parses — that is the whole point of the
  // temp-file dance: a failed write is a no-op, not a truncated file.
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(new SourceStore(file).all().overrides.kimi, { url: 'https://kimi.com/' });
});

test('a damaged main file falls back to the copy beside it', () => {
  const file = tmpFile();
  const store = new SourceStore(file);
  store.patch('kimi', { url: 'https://kimi.com/', enabled: true });
  // The damage comes from outside, after a good write: the backup has the edit.
  fs.writeFileSync(file, '{"overrides":{"kimi":{"url":"https://kimi.c');
  const reopened = new SourceStore(file);
  assert.deepEqual(reopened.all().overrides.kimi, { url: 'https://kimi.com/', enabled: true });
});

test('the damaged file does not overwrite the good copy on the next save', () => {
  const file = tmpFile();
  const store = new SourceStore(file);
  store.patch('kimi', { url: 'https://kimi.com/', enabled: true });
  fs.writeFileSync(file, 'not json');
  const reopened = new SourceStore(file);
  // A save now would otherwise copy the damaged file over the only copy that
  // still has the person's settings in it.
  reopened.patch('chatgpt', { enabled: false });
  const parsed = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.deepEqual(parsed.overrides.kimi, { url: 'https://kimi.com/', enabled: true });
});

test('a custom source whose id collides with a built-in is dropped on load', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      overrides: {},
      custom: [
        { id: 'deepseek', label: 'Fake', glyph: 'F', url: 'https://fake.example.com/', hosts: [], planning: false, enabled: true },
        { id: 'custom-ok', label: 'OK', glyph: 'O', url: 'https://ok.example.com/', hosts: ['ok.example.com'], planning: false, enabled: true }
      ]
    })
  );
  const store = new SourceStore(file);
  assert.deepEqual(store.all().custom.map(source => source.id), ['custom-ok']);
});

test('the agent registry can be swapped without losing its identity', () => {
  const make = id => ({
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: `代表 ${id}` },
    health: async () => ({ id, label: id, available: true, loggedIn: true, pageReady: true, generating: false }),
    ask: async () => {
      throw new Error('not used');
    },
    cancel: () => undefined
  });
  const registry = new SubAgentRegistry([make('deepseek')]);
  assert.deepEqual(registry.list().map(agent => agent.id), ['deepseek']);
  registry.replaceAll([make('deepseek'), make('kimi')]);
  assert.deepEqual(registry.list().map(agent => agent.id), ['deepseek', 'kimi']);
  registry.replaceAll([make('deepseek')]);
  // A disabled source must stop counting toward the readiness pill.
  assert.deepEqual(registry.list().map(agent => agent.id), ['deepseek']);
});

test('two sources never share a rail glyph', () => {
  // The rail is 46px wide and shows one character. Two sources with the same
  // initial are indistinguishable without hovering — Gemini nearly shipped as a
  // second 'G' next to ChatGPT. This is a config fact, so it is checked here
  // rather than by looking at the window.
  const glyphs = BUILTIN_SOURCES.map(source => source.glyph);
  const duplicates = glyphs.filter((glyph, index) => glyphs.indexOf(glyph) !== index);
  assert.deepEqual(duplicates, [], `重名字形：${duplicates.join(', ')}`);
  for (const source of BUILTIN_SOURCES) {
    assert.equal([...source.glyph].length, 1, `${source.id} 的字形必须是一个字符`);
  }
});

test('every built-in source that ships on has a provider profile', () => {
  // A source that is on by default and has no profile falls back to DeepSeek's
  // selectors, which "works" just well enough to look like a bug later.
  for (const source of BUILTIN_SOURCES.filter(item => item.enabled)) {
    assert.ok(PROVIDERS[source.id], `${source.id} 默认开启却没有内置画像`);
  }
  // Gemini ships off, but it is on the rail the moment someone enables it, so
  // its profile has to be there already.
  assert.ok(PROVIDERS.gemini, 'Gemini 缺少内置画像');
  assert.ok(PROVIDERS.gemini.hosts.has('accounts.google.com'), 'Gemini 登录要能跳出 gemini.google.com');
});

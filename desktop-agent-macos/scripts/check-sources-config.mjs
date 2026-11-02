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
import { ChannelRegistry } from '../out-test/main/channels/registry.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sources-')), 'sources.json');

test('the shipped defaults are the four providers, two of them off', () => {
  assert.deepEqual(
    BUILTIN_SOURCES.map(source => source.id),
    ['deepseek', 'chatgpt', 'kimi', 'workbuddy']
  );
  // kimi and workbuddy have no selector profile yet, so enabling them by
  // default would add two pages that cannot answer.
  assert.deepEqual(
    BUILTIN_SOURCES.filter(source => source.enabled).map(source => source.id),
    ['deepseek', 'chatgpt']
  );
});

test('an untouched list is the defaults, in the shipped order', () => {
  const resolved = resolveSources();
  assert.deepEqual(resolved.map(source => source.id), ['deepseek', 'chatgpt', 'kimi', 'workbuddy']);
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
  assert.equal(planningSource(resolved).id, 'deepseek');
});

test('switching the planner off hands planning to the next source that is on', () => {
  const resolved = resolveSources({ overrides: { deepseek: { enabled: false } }, custom: [] });
  assert.equal(planningSource(resolved).id, 'chatgpt');
  assert.equal(planningSource(resolved).planning, false);
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

test('the channel registry can be swapped without losing its identity', () => {
  const make = id => ({
    id,
    label: id,
    status: async () => ({ id, label: id, available: true, loggedIn: true, pageReady: true, generating: false }),
    ask: async () => {
      throw new Error('not used');
    },
    cancel: () => undefined
  });
  const registry = new ChannelRegistry([make('deepseek')]);
  assert.deepEqual(registry.list().map(channel => channel.id), ['deepseek']);
  registry.replaceAll([make('deepseek'), make('kimi')]);
  assert.deepEqual(registry.list().map(channel => channel.id), ['deepseek', 'kimi']);
  registry.replaceAll([make('deepseek')]);
  // A disabled source must stop counting toward the readiness pill.
  assert.deepEqual(registry.list().map(channel => channel.id), ['deepseek']);
});

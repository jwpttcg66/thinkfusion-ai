/**
 * Behaviour tests for the name on the sidebar's bottom row.
 *
 * Two things are being pinned here, and only one of them is cosmetic.
 *
 * The cosmetic one: the name is chosen, not read. The app used to print the
 * operating system's user name and the machine's name, which meant a build could
 * put a person's login name into a screenshot, a screen recording, or a bug
 * report without ever being asked to. That is not a formatting preference, and
 * the tests below assert the *absence* of that path as much as the presence of
 * the new one.
 *
 * The behavioural one: what happens when the stored name is missing, empty,
 * too long, or a corrupt file. Every one of those has to end at 本机用户 rather
 * than at an empty box, because an empty box at the bottom of the sidebar reads
 * as "not signed in" — and there is nothing to sign into.
 *
 * Run with: npm run test:identity
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DISPLAY_NAME,
  MAX_DISPLAY_NAME_LENGTH,
  deviceLabel,
  initialOf,
  normalizeDisplayName
} from '../out-test/shared/identity.js';
import { ProfileStore } from '../out-test/main/profile-store.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'profile-')), 'profile.json');

test('the default name is a description, not an identity', () => {
  assert.equal(DEFAULT_DISPLAY_NAME, '本机用户');
  // No OS call may sneak back in: the name has to be something the person chose.
  // Comments are stripped first — the file explains what it used to do, and that
  // explanation names the calls it must not make.
  const source = fs
    .readFileSync(new URL('../src/shared/identity.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/os\.userInfo|os\.hostname|node:os/.test(source), false);
});

test('the avatar keeps one character, upper-cased only where that means something', () => {
  assert.equal(initialOf('本机用户'), '本');
  assert.equal(initialOf('alice'), 'A');
  assert.equal(initialOf('  bob'), 'B');
  // Emoji are two code units; slicing the string would cut one in half.
  assert.equal(initialOf('🙂 的名字'), '🙂');
  assert.equal(initialOf('   '), '·');
});

test('names are trimmed, not rewritten', () => {
  assert.deepEqual(normalizeDisplayName('  Alice  '), { ok: true, name: 'Alice' });
  assert.deepEqual(normalizeDisplayName('张 三'), { ok: true, name: '张 三' });
});

test('a name that cannot be shown is refused with a sentence', () => {
  assert.equal(normalizeDisplayName('').ok, false);
  assert.equal(normalizeDisplayName('   ').ok, false);
  assert.equal(normalizeDisplayName(42).ok, false);
  assert.equal(normalizeDisplayName('a\nb').ok, false);
  assert.equal(normalizeDisplayName('x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)).ok, false);
  // The rejection text is what the panel puts under the field, so it has to read
  // like something a person would say.
  assert.match(normalizeDisplayName('').error ?? '', /不能是空/);
  assert.match(normalizeDisplayName('x'.repeat(99)).error ?? '', /最多/);
});

test('the second line names the platform, never the machine', () => {
  assert.equal(deviceLabel('darwin'), '这台 Mac');
  assert.equal(deviceLabel('win32'), '这台 Windows');
  assert.equal(deviceLabel('linux'), '这台 Linux');
  assert.equal(deviceLabel('freebsd'), '这台电脑');
});

test('a fresh profile has the default name, and does not write one out', () => {
  const file = tmpFile();
  const store = new ProfileStore(file);
  assert.equal(store.displayName(), DEFAULT_DISPLAY_NAME);
  // Nothing chosen yet means nothing on disk: writing "本机用户" as a stored
  // value would make a future change to the default invisible to this install.
  assert.equal(fs.existsSync(file), false);
});

test('a rename survives a restart', () => {
  const file = tmpFile();
  assert.equal(new ProfileStore(file).setDisplayName('  小柯  '), '小柯');
  assert.equal(new ProfileStore(file).displayName(), '小柯');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written, { displayName: '小柯' });
});

test('reset forgets the name instead of storing the default', () => {
  const file = tmpFile();
  const store = new ProfileStore(file);
  store.setDisplayName('小柯');
  assert.equal(store.reset(), DEFAULT_DISPLAY_NAME);
  assert.equal(new ProfileStore(file).displayName(), DEFAULT_DISPLAY_NAME);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('a refused name is not written', () => {
  const file = tmpFile();
  const store = new ProfileStore(file);
  store.setDisplayName('小柯');
  assert.throws(() => store.setDisplayName('   '), /不能是空/);
  assert.equal(new ProfileStore(file).displayName(), '小柯');
});

test('a corrupt profile degrades to the default instead of an empty row', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"displayName": "');
  assert.equal(new ProfileStore(file).displayName(), DEFAULT_DISPLAY_NAME);

  // A name that violates today's rules is not a name either — the file may have
  // been written by a build with different limits.
  fs.writeFileSync(file, JSON.stringify({ displayName: 'x'.repeat(200) }));
  assert.equal(new ProfileStore(file).displayName(), DEFAULT_DISPLAY_NAME);
});

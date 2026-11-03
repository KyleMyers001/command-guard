import assert from 'node:assert/strict';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import test, {mock} from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {
  hasTriggers,
  regexTriggers,
  triggerMatchers,
} from '../extensions/command-guard/triggers.ts';
import {decide} from './helpers/decide.ts';

// EL-115, PR 4, commit 1: with no view (a command over a size or work limit,
// or one that runs a script that cannot be read) a `BashCmdRegex` rule matches
// only a command that holds its trigger words; any other is read as text, as a
// `BashRegex` rule reads it. With no trigger words to derive it matches all.

const cwd = process.cwd();
const RULE = 'BashCmdRegex(^pnpm -r publish)';
const kinds = [
  ['deny', 'DENY'],
  ['ask', 'ASK'],
] as const;

const over = {
  commit: `git commit -m '${'fix the thing '.repeat(700)}'`,
  echo: `echo ${'a'.repeat(9000)}`,
  sudo: `sudo echo ${'a'.repeat(9000)}`,
  words: `sudo ${'x '.repeat(1100)}`,
  find: `find . ${'-exec a \\; '.repeat(400)}-exec pnpm -r build \\;`,
  script: 'find . -exec sh -c "$X" \';\'',
};

test('the commands under test have no view', () => {
  for (const [name, command] of Object.entries(over)) {
    assert.equal(analyzeCommand(command, cwd).invocations, undefined, name);
  }
});

test('over the cap, a command without the rule’s words is not blocked', async t => {
  for (const [kind] of kinds) {
    for (const [name, command] of Object.entries(over)) {
      assert.equal(await decide(t, {[kind]: [RULE]}, command), 'ALLOW', name);
    }
  }
});

test('over the cap, a command with the rule’s words is blocked', async t => {
  const padded = {
    trailing: `${over.echo}; pnpm -r publish`,
    leading: `pnpm -r publish; echo ${'a'.repeat(9000)}`,
    sudo: `sudo pnpm -r publish ${'x '.repeat(1100)}`,
    commit: `git commit -m '${'fix '.repeat(3000)}'; pnpm -r publish`,
    spaced: `${over.echo}; pnpm   -r    publish`,
    quoted: `${over.echo}; pnpm -r 'pub'"lish"`,
    computed: 'find . -exec sh -c "$X; pnpm -r publish" \';\'',
    find: `find . ${'-exec a \\; '.repeat(400)}-exec pnpm -r publish \\;`,
  };
  for (const [kind, expected] of kinds) {
    for (const [name, command] of Object.entries(padded)) {
      assert.equal(analyzeCommand(command, cwd).invocations, undefined, name);
      assert.equal(await decide(t, {[kind]: [RULE]}, command), expected, name);
    }
  }
});

test('with a view the rule is as exact as before', async t => {
  for (const [kind, expected] of kinds) {
    assert.equal(await decide(t, {[kind]: [RULE]}, 'pnpm -r build'), 'ALLOW');
    assert.equal(
      await decide(t, {[kind]: [RULE]}, 'echo pnpm -r publish'),
      'ALLOW',
    );
    assert.equal(
      await decide(t, {[kind]: [RULE]}, 'FOO=1 pnpm -r publish'),
      expected,
    );
  }
});

test('a rule with no trigger words matches any command with no view', async t => {
  for (const selector of [
    'BashCmdRegex(^x)',
    'BashCmdRegex(^\\w+ \\d+)',
    'BashCmdRegex(^(?:pnpm -r publish)?$)',
    'BashCmdRegex(.*)',
  ]) {
    for (const [kind, expected] of kinds) {
      assert.equal(
        await decide(t, {[kind]: [selector]}, over.echo),
        expected,
        selector,
      );
    }
  }
});

test('a view builder that throws blocks the command', async t => {
  const original = path.basename;
  // Only the view builder fails, so the rest of the guard still runs.
  mock.method(path, 'basename', (...args: Parameters<typeof original>) => {
    if (new Error().stack?.includes('invocations.ts')) throw new Error('boom');
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const kind of ['deny', 'ask']) {
      assert.equal(await decide(t, {[kind]: [RULE]}, 'ls -la'), 'DENY', kind);
    }
    // A policy with no view rule never builds the view.
    assert.equal(await decide(t, {deny: ['BashRegex(^x)']}, 'ls -la'), 'ALLOW');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('trigger words are the literal words every match needs', () => {
  const words = (source: string) => regexTriggers(source);
  assert.deepEqual(words('^pnpm -r publish'), [['pnpm', '-r', 'publish']]);
  assert.deepEqual(words('^pnpm\\s+-r\\s+publish\\b'), [
    ['pnpm', '-r', 'publish'],
  ]);
  assert.deepEqual(words('(?i:^NPM publish)'), [['NPM', 'publish']]);
  assert.deepEqual(words('^(?:npm|pnpm) publish'), [
    ['npm', 'publish'],
    ['pnpm', 'publish'],
  ]);
  assert.deepEqual(words('^git push( --force)?'), [['git', 'push']]);
  assert.deepEqual(words('^git (?:-C \\S+ )?push\\b.*--force'), [
    ['git', 'push', '--force'],
  ]);
  // Only what is required: an optional or repeated part names nothing.
  assert.deepEqual(words('^(?:sudo )?rm -rf /'), [['rm', '-rf']]);
  assert.deepEqual(words('^pnpm -r publi(?:sh)?'), [['pnpm', '-r', 'publi']]);
  assert.deepEqual(words('^git (?<x>push|pull)'), [
    ['git', 'push'],
    ['git', 'pull'],
  ]);
  // Escapes and classes are not literal text.
  assert.equal(words('^\\x70\\u{70}\\p{Lu}'), undefined);
  assert.deepEqual(words('^[a-z]+ \\x41\\x42 push'), [['push']]);
  assert.deepEqual(words('^(?:pnpm|\\w+) publish'), [['publish']]);
  // None to derive: fail closed.
  for (const source of [
    '^x',
    '.*',
    '^\\w+ \\d+',
    '^(?:a|b)?',
    '^(?=pnpm)',
    '^pnpm|',
    '^(pnpm',
    '^pnpm)',
  ]) {
    assert.equal(words(source), undefined, source);
  }
});

test('trigger words are looked for anywhere in the text, in the rule’s case', () => {
  const triggers = (source: string) => triggerMatchers(source) ?? [];
  const sensitive = triggers('^pnpm -r publish');
  assert.ok(hasTriggers('x pnpm y -r z publish', sensitive));
  assert.ok(!hasTriggers('x PNPM y -R z Publish', sensitive));
  assert.ok(!hasTriggers('pnpm -r build', sensitive));
  assert.ok(hasTriggers('npm publish', triggers('^(?:npm|pnpm) publish')));
  assert.ok(
    hasTriggers('x PNPM y -R z Publish', triggers('(?i:^pnpm -r publish)')),
  );
});

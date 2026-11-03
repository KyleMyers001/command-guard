import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {invocations} from '../extensions/command-guard/invocations.ts';
import {matches} from '../extensions/command-guard/match.ts';
import {parseSegments} from '../extensions/command-guard/shell.ts';
import {fixture} from './helpers/fixtures.ts';
import {rule} from './helpers/policy-rule.ts';
import {expectAll} from './helpers/verdict.ts';

// EL-115 / PR 3: the invocation view and the BashCmdRegex selector. This is
// a mechanism only; no shipped rule uses it yet. Commands are only parsed.

const views = (command: string) => invocations(parseSegments(command));

test('the view names each simple command as it would be started', () => {
  assert.deepEqual(views('pnpm -r publish'), ['pnpm -r publish']);
  assert.deepEqual(views('FOO=1 /usr/bin/pnpm -r publish'), [
    'pnpm -r publish',
  ]);
  assert.deepEqual(views('env -i A=b time -p ./bin/lerna publish'), [
    'lerna publish',
  ]);
  assert.deepEqual(views('echo "a b" \'c\'; ls | wc'), [
    "echo 'a b' c",
    'ls',
    'wc',
  ]);
  assert.deepEqual(views('FOO=1'), []);
});

test('a prefix or an unknown wrapper option also exposes the later command', () => {
  assert.ok(views('sudo -u root pnpm -r publish').includes('pnpm -r publish'));
  assert.ok(views('timeout 60 npm publish').includes('npm publish'));
  assert.ok(views('nohup pnpm -r publish').includes('pnpm -r publish'));
  assert.ok(views('env -C dir pnpm -r publish').includes('pnpm -r publish'));
  assert.ok(views('env $OPTS pnpm -r publish').includes('pnpm -r publish'));
  // The command as written is always kept.
  assert.ok(views('sudo -u root pnpm -r publish')[0].startsWith('sudo '));
});

test('shell strings contribute their own commands, and Git globals are dropped', () => {
  const {invocations: found} = analyzeCommand(
    "bash -c 'cd x && git -C repo push --force'",
    process.cwd(),
  );
  assert.ok(found.includes('git push --force'));
  assert.ok(found.includes('cd x'));
  assert.ok(found.some(view => view.startsWith('bash -c')));

  // A tool named only as an argument is not an invocation.
  const mention = analyzeCommand('echo git status', process.cwd()).invocations;
  assert.deepEqual(mention, ['echo git status']);
  const wrapped = analyzeCommand('FOO=1 git -C r status', process.cwd());
  assert.ok(wrapped.invocations.includes('git status'));
});

test('a very long command still has every start, held as slices', () => {
  const words = Array.from({length: 5000}, () => 'x').join(' ');
  const found = views(`sudo ${words} pnpm -r publish`);
  assert.ok(found[0].startsWith('sudo '));
  assert.ok(found.includes('pnpm -r publish'));
  assert.ok(found.length >= 5000);
});

test('BashCmdRegex compiles like BashRegex and is matched against views', t => {
  const root = fixture(t);
  const compiled = rule(t, 'BashCmdRegex(^pnpm -r publish$)');
  assert.equal(compiled.view, 'invocation');
  assert.equal(compiled.tool, 'bash');
  assert.equal(compiled.regex?.flags, 'u');

  const text = ['echo pnpm -r publish', 'echo pnpm -r publish'];
  assert.equal(matches(compiled, 'bash', text, root, root, ['echo']), false);
  assert.equal(
    matches(compiled, 'bash', text, root, root, ['pnpm -r publish']),
    true,
  );
  // Without a view the spellings are searched, which can only add matches.
  assert.equal(
    matches(compiled, 'bash', ['pnpm -r publish'], root, root),
    true,
  );
  assert.equal(matches(compiled, 'bash', ['echo hi'], root, root), false);
  assert.equal(
    matches(compiled, 'read', ['pnpm -r publish'], root, root, [
      'pnpm -r publish',
    ]),
    false,
  );
});

test('BashCmdRegex takes the same modifiers and rejects bad expressions', t => {
  assert.equal(rule(t, 'BashCmdRegex((?i:^npm publish))').regex?.flags, 'iu');
  for (const selector of [
    'BashCmdRegex',
    'BashCmdRegex()',
    'BashCmdRegex([private)',
    'BashCmdRegex(a\0b)',
  ]) {
    assert.throws(() => rule(t, selector), /expression|NUL|valid|Supported/u);
  }
});

test('through the guard: the rule blocks the command, not prose about it', async t => {
  const dir = fixture(t);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      permissions: {deny: ['BashCmdRegex(^pnpm -r publish)'], ask: []},
    }),
  );
  const guard = createCommandGuard({policyPath});
  const blocked = async (command: string) => {
    const result = await guard(
      {
        type: 'tool_call',
        toolCallId: 'view',
        toolName: 'bash',
        input: {command},
      } as ToolCallEvent,
      {
        cwd: dir,
        hasUI: false,
        mode: 'print',
        signal: new AbortController().signal,
      } as unknown as ExtensionContext,
    );
    return result?.block === true;
  };

  for (const command of [
    'pnpm -r publish',
    'FOO=1 /usr/bin/pnpm -r publish --tag x',
    'echo ok && pnpm -r publish',
    'sudo pnpm -r publish',
    "bash -c 'pnpm -r publish'",
  ]) {
    assert.equal(await blocked(command), true, command);
  }
  for (const command of [
    'pnpm -r build',
    'echo pnpm -r publish',
    'git commit -m "pnpm -r publish"',
    'rg "pnpm -r publish" docs',
  ]) {
    assert.equal(await blocked(command), false, command);
  }
});

// Ruling (c): the openclaw deny matches any mention and stays exactly as it
// is. The invocation view is additive, so it cannot make it narrower.
test('the shipped openclaw deny still blocks any mention', async () => {
  await expectAll(
    [
      'openclaw status',
      'rg openclaw',
      'rg openclaw docs',
      'git commit -m "openclaw"',
      "echo 'openclaw'",
      'cat notes-openclaw.txt',
      "bash -c 'rg openclaw'",
    ],
    'DENY',
  );
});

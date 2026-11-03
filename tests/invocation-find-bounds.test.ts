import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {matches} from '../extensions/command-guard/match.ts';
import {rule} from './helpers/policy-rule.ts';
import {verdict} from './helpers/verdict.ts';

// EL-115, PR 3, round 3: `find -exec` payloads are read once each, and a
// command with more of them than the view follows has no view, so rules match
// its spelling as they did before the view existed.

const cwd = process.cwd();
const repeat = (prefix: string, times: number, tail: string) =>
  `${prefix}${'find . -exec '.repeat(times)}${tail}`;

function timed<T>(run: () => T): {value: T; ms: number} {
  const start = performance.now();
  const value = run();
  return {value, ms: performance.now() - start};
}

function matcher(t: Parameters<typeof rule>[0], selector: string) {
  const compiled = rule(t, selector);
  return (command: string) => {
    const {canonical, invocations} = analyzeCommand(command, cwd);
    return matches(
      compiled,
      'bash',
      [command, canonical],
      cwd,
      cwd,
      invocations,
    );
  };
}

test('repeated find -exec is analyzed in linear time', () => {
  analyzeCommand('find . -exec ls \\;', cwd);
  for (const [prefix, times] of [
    ['', 20],
    ['', 40],
    ['', 50],
    ['', 500],
    ['sudo ', 16],
    ['sudo ', 40],
    ['sudo ', 50],
    ['sudo ', 500],
    ['timeout 5 ', 50],
  ] as const) {
    const {ms} = timed(() => analyzeCommand(repeat(prefix, times, 'ls'), cwd));
    assert.ok(ms < 50, `${prefix}find -exec x${times} took ${ms} ms`);
  }

  const many = `find . ${'-exec a \\; '.repeat(20000)}`;
  assert.ok(timed(() => analyzeCommand(many, cwd)).ms < 1000);
  const words = `find . -exec ${'x '.repeat(100000)}`;
  assert.ok(timed(() => analyzeCommand(words, cwd)).ms < 1000);
});

test('a find payload is read once, so a mention inside one is no command', t => {
  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  for (const command of [
    'find . -exec echo -exec pnpm -r publish \\;',
    'find . -exec echo -execdir pnpm -r publish \\;',
  ]) {
    assert.equal(cmd(command), false, command);
  }

  // Real payloads, nested and in a row, are still found.
  for (const command of [
    'find . -exec find . -exec find . -exec pnpm -r publish \\; \\; \\;',
    'find . -exec echo \\; -exec pnpm -r publish \\;',
    'sudo find . -exec echo \\; -exec pnpm -r publish \\;',
    'sudo find . -name x find . -exec pnpm -r publish \\;',
    'find . -exec sudo find . -exec pnpm -r publish \\; \\;',
  ]) {
    assert.equal(cmd(command), true, command);
  }
});

test('past the limits there is no view, and rules match the spelling', t => {
  const capped = [
    repeat('', 500, 'pnpm -r publish'),
    repeat('sudo ', 50, 'pnpm -r publish'),
    repeat('', 9, 'pnpm -r publish'),
    `find . ${'-exec echo a \\; '.repeat(300)}-exec pnpm -r publish \\;`,
  ];
  for (const command of capped) {
    assert.equal(analyzeCommand(command, cwd).invocations, undefined, command);
  }
  assert.ok(analyzeCommand(repeat('', 6, 'ls'), cwd).invocations);
  assert.ok(
    analyzeCommand('find . -exec echo a \\; '.repeat(100), cwd).invocations,
  );

  // A view rule gives the verdict the text rule of the same pattern gives.
  const cmd = matcher(t, 'BashCmdRegex(pnpm -r publish)');
  const text = matcher(t, 'BashRegex(pnpm -r publish)');
  const anchored = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  for (const command of [...capped, repeat('', 500, 'ls')]) {
    assert.equal(cmd(command), text(command), command);
  }
  // Anchored, it sees only the command as written, as main's rules do.
  assert.equal(anchored(capped[0]), false);
  assert.equal(anchored('pnpm -r publish; ' + capped[0]), true);
});

test('shipped verdicts do not depend on the view', async () => {
  for (const [command, expected] of [
    [repeat('', 500, 'git push --force origin x'), 'DENY'],
    [repeat('sudo ', 50, 'git push --force origin x'), 'DENY'],
    [repeat('', 500, 'ls'), 'ALLOW'],
    [repeat('', 40, 'ls'), 'ALLOW'],
  ] as const) {
    assert.equal(await verdict(command), expected, command.slice(0, 60));
  }
});

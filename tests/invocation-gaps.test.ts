import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {invocations} from '../extensions/command-guard/invocations.ts';
import {matches} from '../extensions/command-guard/match.ts';
import {parseSegments} from '../extensions/command-guard/shell.ts';
import {rule} from './helpers/policy-rule.ts';

// CR's three latent gaps in the invocation view (EL-115, PR 3, round 2). For
// each, a `^`-anchored BashCmdRegex rule must match exactly where the
// unanchored BashRegex rule for the same command does, where the command runs.

const cwd = process.cwd();

// Whether a test-only rule matches the command, as the guard calls `matches`.
function matcher(t: Parameters<typeof rule>[0], selector: string) {
  const compiled = rule(t, selector);
  return (command: string) => {
    const {canonical, invocations: views} = analyzeCommand(command, cwd);
    return matches(compiled, 'bash', [command, canonical], cwd, cwd, views);
  };
}

// Both selectors agree that `command` runs `invoked`; `^` anchors the view.
function expectBoth(
  t: Parameters<typeof rule>[0],
  invoked: string,
  commands: string[],
) {
  const cmd = matcher(t, `BashCmdRegex(^${invoked})`);
  const text = matcher(t, `BashRegex(${invoked})`);
  for (const command of commands) {
    assert.equal(text(command), true, `BashRegex ${command}`);
    assert.equal(cmd(command), true, `BashCmdRegex ${command}`);
  }
}

test('gap 1: shell keywords before the command are not part of it', t => {
  expectBoth(t, 'viewpm -r publish', [
    'if true; then viewpm -r publish; fi',
    'if ! viewpm -r publish; then echo no; fi',
    'if viewpm -r publish; then echo ok; fi',
    'if false; then :; else viewpm -r publish; fi',
    'if false; then :; elif viewpm -r publish; then :; fi',
    'while viewpm -r publish; do :; done',
    'while true; do viewpm -r publish; done',
    'until false; do viewpm -r publish; done',
    'for x in a b; do viewpm -r publish; done',
    '{ viewpm -r publish; }',
    '{ echo a; viewpm -r publish; }',
    '! viewpm -r publish',
    'if true; then { ! viewpm -r publish; }; fi',
    'if true; then sudo viewpm -r publish; fi',
    'case x in a) viewpm -r publish;; esac',
  ]);
});

test('gap 1: find runs its -exec payload as a command', t => {
  expectBoth(t, 'viewpm -r publish', [
    'find . -exec viewpm -r publish \\;',
    'find . -name x -exec viewpm -r publish {} +',
    'find . -execdir viewpm -r publish \\;',
    'find . -ok viewpm -r publish \\;',
    'find . -exec env A=1 viewpm -r publish \\;',
    'find . -exec sudo viewpm -r publish \\;',
    'find . -exec find . -exec viewpm -r publish \\; \\;',
    'sudo find . -exec viewpm -r publish \\;',
    'find . -type f -exec echo \\; -exec viewpm -r publish \\;',
  ]);
});

test('gap 1: a mention is still not a command', t => {
  const cmd = matcher(t, 'BashCmdRegex(^viewpm -r publish)');
  for (const command of [
    'if true; then echo viewpm -r publish; fi',
    'for x in viewpm -r publish; do echo $x; done',
    'find . -name viewpm -exec echo viewpm -r publish \\;',
    'find . -name "viewpm -r publish"',
    'echo "if true; then viewpm -r publish; fi"',
    'rg viewpm -r publish',
  ]) {
    assert.equal(cmd(command), false, command);
  }
});

const PREFIXES = [
  'command',
  'sudo',
  'sudo -n',
  'sudo -u root',
  'exec',
  'nohup',
  'timeout 5',
  'timeout -s KILL 5',
  'nice',
  'nice -n 5',
  'xargs',
  'xargs -n1',
  'doas',
  'env sudo',
  'env A=1 sudo -n',
  'command sudo',
  'sudo env A=1',
  'sudo timeout 5 nice',
];

test('gap 2: git and gh globals are dropped after a prefix', t => {
  const gh = [
    'gh -R x pr merge 1',
    'gh --repo x/y pr merge 1',
    'gh -Rx/y pr merge',
  ];
  expectBoth(
    t,
    'gh pr merge',
    PREFIXES.flatMap(prefix => gh.map(command => `${prefix} ${command}`)),
  );
  expectBoth(
    t,
    'git push --force',
    PREFIXES.map(prefix => `${prefix} git -C repo push --force origin x`),
  );
  expectBoth(t, 'git push --force', [
    'if true; then git -C r push --force; fi',
    'find . -exec git -C r push --force \\;',
  ]);
  expectBoth(t, 'gh pr merge', [
    'if true; then gh -R x pr merge; fi',
    'find . -exec gh -R x pr merge \\;',
  ]);
});

test('gap 2: a tool named as an argument is still not run', t => {
  const cmd = matcher(t, 'BashCmdRegex(^gh pr merge)');
  for (const command of [
    'echo gh -R x pr merge',
    'echo sudo gh -R x pr merge',
    'git commit -m "gh -R x pr merge"',
    'rg "gh pr merge" docs',
  ]) {
    assert.equal(cmd(command), false, command);
  }
});

test('gap 3: no start is skipped past the cap', t => {
  const assignments = Array.from({length: 40}, (_, i) => `A${i}=1`).join(' ');
  const nested = Array.from({length: 40}, () => 'sudo -n').join(' ');
  const options = Array.from({length: 60}, (_, i) => `-o${i}`).join(' ');
  expectBoth(t, 'viewpm -r publish', [
    `sudo env ${assignments} viewpm -r publish`,
    `${nested} viewpm -r publish`,
    `sudo env ${assignments} /usr/bin/viewpm -r publish`,
    `timeout ${options} 5 viewpm -r publish`,
    `xargs ${options} viewpm -r publish`,
    `sudo ${'x '.repeat(900)}viewpm -r publish`,
  ]);
  expectBoth(t, 'gh pr merge', [
    `sudo env ${assignments} gh -R x pr merge`,
    `${nested} gh -R x pr merge`,
  ]);
  const cmd = matcher(t, 'BashCmdRegex(^viewpm -r publish)');
  assert.equal(cmd(`sudo env ${assignments} viewpm -r build`), false);
});

test('gap 3: starts past the cap are spelled like the ones before it', () => {
  const words = [
    'sudo',
    ...Array.from({length: 35}, (_, i) => `w${i}`),
    '/usr/bin/viewpm',
    "'a b'",
    '$X',
    'dir/',
    '"it\'s"',
    '/opt/my\\ tool/run',
    'last',
  ];
  const found = invocations(parseSegments(words.join(' ')));
  for (let i = 1; i < words.length; i++) {
    const [expected] = invocations(parseSegments(words.slice(i).join(' ')));
    assert.ok(found.includes(expected), `${i}: ${expected}`);
  }
});

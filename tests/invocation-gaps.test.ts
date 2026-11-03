import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {invocations} from '../extensions/command-guard/invocations.ts';
import {matches} from '../extensions/command-guard/match.ts';
import {parseSegments} from '../extensions/command-guard/shell.ts';
import {rule} from './helpers/policy-rule.ts';
import {verdict} from './helpers/verdict.ts';

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
  expectBoth(t, 'pnpm -r publish', [
    'if true; then pnpm -r publish; fi',
    'if ! pnpm -r publish; then echo no; fi',
    'if pnpm -r publish; then echo ok; fi',
    'if false; then :; else pnpm -r publish; fi',
    'if false; then :; elif pnpm -r publish; then :; fi',
    'while pnpm -r publish; do :; done',
    'while true; do pnpm -r publish; done',
    'until false; do pnpm -r publish; done',
    'for x in a b; do pnpm -r publish; done',
    '{ pnpm -r publish; }',
    '{ echo a; pnpm -r publish; }',
    '! pnpm -r publish',
    'if true; then { ! pnpm -r publish; }; fi',
    'if true; then sudo pnpm -r publish; fi',
    'case x in a) pnpm -r publish;; esac',
  ]);
});

test('gap 1: find runs its -exec payload as a command', t => {
  expectBoth(t, 'pnpm -r publish', [
    'find . -exec pnpm -r publish \\;',
    'find . -name x -exec pnpm -r publish {} +',
    'find . -execdir pnpm -r publish \\;',
    'find . -ok pnpm -r publish \\;',
    'find . -exec env A=1 pnpm -r publish \\;',
    'find . -exec sudo pnpm -r publish \\;',
    'find . -exec find . -exec pnpm -r publish \\; \\;',
    'sudo find . -exec pnpm -r publish \\;',
    'find . -type f -exec echo \\; -exec pnpm -r publish \\;',
  ]);
});

test('gap 1: a mention is still not a command', t => {
  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  for (const command of [
    'if true; then echo pnpm -r publish; fi',
    'for x in pnpm -r publish; do echo $x; done',
    'find . -name pnpm -exec echo pnpm -r publish \\;',
    'find . -name "pnpm -r publish"',
    'echo "if true; then pnpm -r publish; fi"',
    'rg pnpm -r publish',
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
  expectBoth(t, 'pnpm -r publish', [
    `sudo env ${assignments} pnpm -r publish`,
    `${nested} pnpm -r publish`,
    `sudo env ${assignments} /usr/bin/pnpm -r publish`,
    `timeout ${options} 5 pnpm -r publish`,
    `xargs ${options} pnpm -r publish`,
    `sudo ${'x '.repeat(5000)}pnpm -r publish`,
  ]);
  expectBoth(t, 'gh pr merge', [
    `sudo env ${assignments} gh -R x pr merge`,
    `${nested} gh -R x pr merge`,
  ]);
  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  assert.equal(cmd(`sudo env ${assignments} pnpm -r build`), false);
});

test('gap 3: starts past the cap are spelled like the ones before it', () => {
  const words = [
    'sudo',
    ...Array.from({length: 35}, (_, i) => `w${i}`),
    '/usr/bin/pnpm',
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

test('scripts run after a prefix are read, a computed one is not', async () => {
  for (const command of [
    "sudo bash -c 'git push --force origin x'",
    "command bash -c 'git push --force origin x'",
    "sudo -u bash bash -c 'git push --force origin x'",
    "nohup sh -c 'git push --force origin x' &",
    "timeout 5 eval 'git push --force origin x'",
    "env sudo bash -lc 'git push --force origin x'",
  ]) {
    const {decisions, invocations: views} = analyzeCommand(command, cwd);
    assert.ok(
      decisions.some(d => d.verdict === 'deny'),
      command,
    );
    assert.ok(views.includes('git push --force origin x'), command);
  }

  // As on main: nothing new is decided about a script the guard cannot read.
  for (const command of [
    'sudo bash -c "$SCRIPT"',
    'xargs -I{} sh -c "$CMD {}"',
    'sudo echo eval $HOME',
  ]) {
    assert.deepEqual(analyzeCommand(command, cwd).decisions, [], command);
  }
  assert.equal(await verdict('nice ls -l'), 'ALLOW');
});

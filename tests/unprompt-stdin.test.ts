import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts, verdict} from './helpers/verdict.ts';

// EL-115 PR6: a stdin-fed command naming a shell anywhere, or holding an
// expansion, raises one flag line. Chains with a newly allowed class and the
// flag keep prompting; standalone commands keep main's verdict.
const flagged = (command: string): boolean =>
  analyzeCommand(command, '/')
    .canonical.split('\n')
    .includes('__stdin_shell__');

test('the stdin-shell flag follows feed forms, not spellings', () => {
  for (const command of [
    'cat s | timeout 30 "$SHELL"',
    'cat s | xargs -n1 bash -c',
    'cat s | nice -n 5 /bin/sh',
    'cat s | stdbuf -o0 zsh',
    'busybox sh < s',
    "fish <<<'x'",
    'cat s | env $(echo sh)',
    'cat s | `which bash`',
    'cat s |& b""ash',
    'diff <(sh x) y',
    'mksh /dev/stdin',
    'cat s | b{a..a}sh',
  ])
    assert.ok(flagged(command), command);
  for (const command of [
    'echo bash',
    'bash script.sh',
    "printf '%s' 'rm -rf $HOME/*'",
    'cat s | grep bash-like',
    'true || bash',
    'cat s | tee out.txt',
  ])
    assert.ok(!flagged(command), command);
});

test('Codex P1 4464014027 and wrappers with arguments keep prompting', async t => {
  await expectVerdicts(
    'ASK',
    [
      'SHELL=/bin/bash; rm -rf dist; cat script.sh | timeout 30 "$SHELL"',
      'rm -rf dist; cat s | xargs -n1 bash -c',
      'git merge feat/x; cat s | nice -n 5 sh',
      'rm -rf dist; cat s | stdbuf -o0 bash',
      'rm -rf dist; cat script.sh | b{a..a}sh',
      'git config user.name; cat s | timeout -s KILL 30 env -u X "$S"',
    ],
    fixture(t),
  );
});

const CLASSES = ['rm -rf dist', 'git merge feat/x', 'npm run test:migrations'];
const WRAPPERS = [
  '',
  'timeout 30 ',
  'xargs -n1 ',
  'nice -n 5 ',
  'stdbuf -o0 ',
  'env -u A ',
];
const SHELLS = [
  'bash',
  '/bin/sh',
  "z''sh",
  '"$SHELL"',
  '$(echo sh)',
  'ba${X:-s}h',
];
const FEEDS = [
  (c: string) => `cat s | ${c}`,
  (c: string) => `${c} <<EOF\necho hi\nEOF`,
  (c: string) => `${c} <<<'echo hi'`,
  (c: string) => `${c} < s.sh`,
  (c: string) => `${c} <(cat s)`,
];

test('generated class x wrapper x shell x feed sweep keeps prompting', async t => {
  const cwd = fixture(t);
  const allowed: string[] = [];
  for (const c of CLASSES)
    for (const w of WRAPPERS)
      for (const sh of SHELLS)
        for (const feed of FEEDS) {
          const command = `${c}; ${feed(w + sh)}`;
          if ((await verdict(command, cwd)) === 'ALLOW') allowed.push(command);
        }
  assert.deepEqual(allowed, []);
});

test('standalone stdin shells and the migration contract keep main verdicts', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'cat s | timeout 30 bash',
      'echo hi | xargs -n1 sh -c',
      "printf '%s' 'rm -rf $HOME/*'",
      "rm -rf dist; printf '%s' 'rm -rf $HOME/*' | cat",
    ],
    fixture(t),
  );
});

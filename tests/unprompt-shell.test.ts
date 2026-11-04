import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts, verdict} from './helpers/verdict.ts';

// EL-115 PR6: a chain that feeds a shell from a pipe, heredoc, here-string
// or process substitution keeps asking when it holds a newly allowed class.
// A shell fed that way on its own keeps main's verdict.
const CLASSES = [
  'rm -rf dist',
  '/bin/rm -rf build',
  "gh api graphql -f query='{viewer{login}}'",
  'git merge feat/x',
  'git config user.name',
  'git checkout --detach HEAD~1',
  'curl -o out.json https://x.test/a',
  'npm run test:migrations',
];
const SHELLS = [
  'sh',
  'bash -s',
  'zsh',
  'dash',
  'ksh',
  '/bin/sh',
  '/usr/bin/env bash',
  'env sh',
  'command bash',
  '\\bash',
  '"bash"',
  "b''ash",
  'sh -s --',
];
const SEPARATORS = [' && ', ' ; ', ' || ', '\n'];

function chains(): string[] {
  const out: string[] = [];
  for (const c of CLASSES) {
    for (const sh of SHELLS) {
      out.push(`${c} | ${sh}`);
      for (const sep of SEPARATORS) {
        out.push(`${c}${sep}${sh} <<EOF\necho hi\nEOF`);
        out.push(`${c}${sep}${sh} <<<'echo hi'`);
        out.push(`${c}${sep}${sh} <(cat x.sh)`);
        out.push(`${c}${sep}echo hi | ${sh}`);
        out.push(`${sh} <<EOF\necho hi\nEOF\n${c}`);
      }
    }
  }
  return out;
}

test('named pipe-to-shell chains keep asking', async t => {
  await expectVerdicts(
    'ASK',
    [
      "gh api graphql -f query='{viewer{login}}' | bash",
      'git config core.editor | sh',
      'git config user.name | sh',
      'rm -rf dist && bash <<EOF\necho hi\nEOF',
      'git merge feat/x && bash <(cat x.sh)',
      "rm -rf dist; 'zsh' <<<'echo hi'",
      'sh <<EOF\necho hi\nEOF && git config user.name',
      'rm -rf dist; cat script.sh | bash -s -- arg',
      'git merge feat/x && cat s | bash -xs a b',
      'rm -rf dist; cat s | sh -- a',
      'rm -rf dist\nbash -s arg <<EOF\necho hi\nEOF',
    ],
    fixture(t),
  );
});

// Main denies some curl forms outright; none may come back ALLOW.
test('generated class x separator x shell x form sweep keeps prompting', async t => {
  const cwd = fixture(t);
  const allowed: string[] = [];
  for (const command of chains())
    if ((await verdict(command, cwd)) === 'ALLOW') allowed.push(command);
  assert.deepEqual(allowed, []);
});

test('a shell fed on its own keeps main verdict', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'echo hi | sh',
      'cat x.sh | bash',
      'bash <<EOF\necho hi\nEOF',
      "zsh <<<'echo hi'",
      'npm run format | sh',
      'bash script.sh',
      'cat s | bash -s -- arg',
    ],
    fixture(t),
  );
});

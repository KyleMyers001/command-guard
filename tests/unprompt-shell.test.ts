import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectNotExempt, expectVerdicts, verdict} from './helpers/verdict.ts';

// A chain that feeds a shell from a pipe, heredoc, here-string or process
// substitution is never exempt, so it keeps main's verdict (or the pipe to a
// shell deny). A shell fed that way on its own keeps main's verdict.
const CLASSES = [
  'rm -rf dist',
  '/bin/rm -rf build',
  "gh api graphql -f query='{viewer{login}}'",
  'git merge feat/x',
  'git config user.name',
  'git checkout --detach HEAD~1',
  'curl -o out.json https://example.com/a',
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
      'rm -rf dist; if true; then bash <<EOF\necho hi\nEOF\nfi',
      'git merge feat/x; if true; then bash < script.sh; fi',
      'rm -rf dist; while true; do sh <<<x; done',
      'rm -rf dist; (bash < s.sh)',
      'rm -rf dist; ! bash < s.sh',
      'SHELL=/bin/bash; rm -rf dist; cat script.sh | "$SHELL"',
      'unset X; rm -rf dist; cat script.sh | ba${X:-s}h',
      'rm -rf dist; cat s | `echo bash` -s',
      'rm -rf dist; x | env $(echo sh)',
      "rm -rf dist; cat script.sh | bash --rcfile '/tmp/a b'",
      'rm -rf dist; cat s | bash -O "x y" -s',
      'rm -rf dist; cat script.sh | timeout 30 bash',
      'git merge feat/x; cat s | stdbuf -oL sh',
      'rm -rf dist; cat s | setsid -w bash -s',
      'rm -rf dist; { bash < s.sh; }',
      'rm -rf dist; cat script.sh | bash /dev/stdin',
      'rm -rf dist; cat script.sh | bash /dev/fd/0 arg',
      'rm -rf dist; cat script.sh | sh /proc/self/fd/0',
      'git merge feat/x && bash <(cat x.sh)',
      "rm -rf dist; 'zsh' <<<'echo hi'",
      'sh <<EOF\necho hi\nEOF && git config user.name',
      'rm -rf dist; cat script.sh | bash -s -- arg',
      'git merge feat/x && cat s | bash -xs a b',
      'rm -rf dist; cat s | sh -- a',
      'rm -rf dist; cat script.sh | bash -O extglob',
      'rm -rf dist; cat script.sh | env -u BASH_ENV bash',
      'rm -rf dist; cat s | env --unset BASH_ENV sh',
      'rm -rf dist; cat s | env -u A -u B bash',
      'rm -rf dist; cat s | nice -n 5 sh',
      'rm -rf dist; cat script.sh | bash +O extglob -o pipefail',
      'rm -rf dist; cat script.sh | bash --rcfile /dev/null',
      'rm -rf dist; cat script.sh | bash --init-file x -x',
      'rm -rf dist\nbash -s arg <<EOF\necho hi\nEOF',
    ],
    fixture(t),
  );
});

test('generated class x separator x shell x form sweep is never exempt', t => {
  expectNotExempt(chains(), fixture(t));
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

test('repeated shell value options stay linear', async t => {
  const cmd = `rm -rf dist; cat s | bash ${'--rcfile '.repeat(5000)}-s arg`;
  const start = Date.now();
  assert.equal(await verdict(cmd, fixture(t)), 'ASK');
  assert.ok(Date.now() - start < 2000);
});

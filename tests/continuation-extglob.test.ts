import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSegments,
  type ShellMode,
} from '../extensions/command-guard/shell.ts';
import {expectAll} from './helpers/verdict.ts';

// CR on #10 @c97422e (EL-115): a backslash-newline between a redirect operator
// and `(`, and extglob `!( )`, both reach the `(` branch of the scanner as if
// they were a plain subshell. Both must fail closed.

const FLAGS = ['--force', '-f', '--delete', '+feat/x', ':feat/x'];
const GAPS = ['\\\n', '\\\r\n', ' \\\n', '\\\n\\\n'];
const OPERATORS = ['>', '<', '>>', '&>', '2>', '>&', '<<<'];

const push = (flag: string) =>
  flag.startsWith('+') || flag.startsWith(':')
    ? ['git push origin', flag]
    : ['git push origin feat/x', flag];

const continued = OPERATORS.flatMap(op =>
  GAPS.flatMap(gap =>
    FLAGS.map(flag => {
      const [head, tail] = push(flag);
      return `${head} ${op}${gap}(a | b) ${tail}`;
    }),
  ),
);

test('a continuation between the redirect operator and ( still blocks push flags', async () => {
  await expectAll(
    [
      'git push origin feat/x >\\\n(a | b) --force',
      'git push origin feat/x <\\\n(a | b) --force',
      '/usr/bin/git push origin feat/x >\\\n(a | b) -f',
      ...continued,
    ],
    'DENY',
  );
});

test('the continuation variants also block inside bash -c and eval', async () => {
  const inner = [
    'git push origin feat/x >\\\n(a | b) --force',
    'git push origin feat/x <\\\n(a | b) -f',
    'git push origin feat/x >\\\n(a | b) --delete',
    'git push origin +feat/x >\\\n(a | b)',
    'git push origin :feat/x <\\\n(a | b)',
  ];
  await expectAll(
    inner.flatMap(command => [
      `bash -c '${command}'`,
      `eval '${command}'`,
      `sh -c "${command}"`,
    ]),
    'DENY',
  );
});

const EXTGLOB = [
  'shopt -s extglob\ngit push origin feat/x !(a|b) --force',
  'shopt -s extglob\ngit push origin feat/x !(a|b) -f',
  'shopt -s extglob\ngit push origin feat/x !(a|b) --delete',
  'shopt -s extglob\ngit push origin !(a|b) +feat/x',
  'shopt -s extglob\ngit push origin !(a|b) :feat/x',
  'shopt -s extglob; git push origin feat/x @(a|b) --force',
  'shopt -s extglob; git push origin feat/x ?(a|b) -f',
  "bash -O extglob -c 'git push origin feat/x !(a) --force'",
  "bash -O extglob -c 'git push origin feat/x !(a) -f'",
  "bash -O extglob -c 'git push origin feat/x !(a) --delete'",
  "bash -O extglob -c 'git push origin !(a) +feat/x'",
  "eval 'shopt -s extglob; git push origin feat/x !(a|b) --force'",
];

test('extglob groups before a push flag still block', async () => {
  await expectAll(EXTGLOB, 'DENY');
});

test('the scanner flags a ( after a word or a redirect, and only then', () => {
  const uncertain = (command: string) => {
    const mode: ShellMode = {legacy: false, uncertain: false};
    parseSegments(command, mode);
    return mode.uncertain;
  };
  for (const command of [
    'ls !(a|b)',
    'echo x >\\\n(cat)',
    'echo x <\\\n(cat)',
    'git push origin feat/x >\\\n(a | b) --force',
    'echo a b(c)',
  ]) {
    assert.equal(uncertain(command), true, command);
  }
  for (const command of ['(cd sub && ls)', 'a | (b)', 'echo hi; (cd sub)']) {
    assert.equal(uncertain(command), false, command);
  }
});

test('benign process substitutions, subshells, case and functions are unchanged', async () => {
  await expectAll(
    [
      'diff <(a) <(b)',
      'diff <(sort a) <(sort b)',
      'exec > >(tee log)',
      'cat <(echo hi)',
      'tee >(cat) < in',
      "echo $(cat <<'EOF'\nhello (x)\nEOF\n)",
      'case x in a) echo hi;; esac',
      'case $x in\n  a|b) echo one ;;\n  *) echo two ;;\nesac',
      'f() { echo hi; }',
      'f() { echo hi; }\nf',
      'function g { echo hi; }',
      '(cd sub && ls)',
      '(a | b) && ls',
      'ls !(a|b)',
      'echo a >\\\n out.txt',
      'git push origin feat/x',
      'git push origin feat/x > out.txt',
    ],
    'ALLOW',
  );
});

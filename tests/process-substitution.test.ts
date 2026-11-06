import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {
  parseSegments,
  type ShellMode,
} from '../extensions/command-guard/shell.ts';
import {expectAll, repository, verdict} from './helpers/verdict.ts';

// CR on #10 @3aa3ba7 (EL-115): compound redirect operators, `case` inside a
// substitution, and the fail-closed rule for anything the scanner is unsure of.

const COMPOUND_OPERATORS = [
  '&>',
  '&>>',
  '>|',
  '>&',
  '>>',
  '<<',
  '<<<',
  '<>',
  '2>',
  '2>>',
  '>',
  '<',
];

// The operator and the `>(` / `<(` can run together: `>&>(cat)`, `&>>>(cat)`.
const compound = (command: string, flag: string) =>
  COMPOUND_OPERATORS.flatMap(op =>
    ['>(cat)', '<(cat)'].flatMap(sub => [
      `${command} ${op}${sub} ${flag}`,
      `${command} ${op} ${sub} ${flag}`,
    ]),
  );

test('compound operators before a process substitution still block push flags', async () => {
  await expectAll(
    [
      'git push origin feat/x >&>(cat) --force',
      'git push origin feat/x >|>(cat) -f',
      'git push origin feat/x &>>>(cat) --force',
      'git push origin feat/x &>>>(cat) --delete',
      '/usr/bin/git push origin feat/x >>>(cat) --force',
      '/usr/bin/git push origin feat/x 2>>>(cat) --force',
      '/usr/bin/git push origin feat/x ><(cat) --force',
      '/usr/bin/git push origin feat/x <<<<(cat) --force',
      ...compound('git push origin feat/x', '--force'),
      ...compound('/usr/bin/git push origin feat/x', '-f'),
      ...compound('git push origin feat/x', '--delete'),
      ...compound("bash -c 'git push origin feat/x", "--force'"),
    ],
    'DENY',
  );
});

test('compound operators keep the outer command in one segment', () => {
  for (const op of COMPOUND_OPERATORS) {
    for (const sub of ['>(cat)', '<(cat)']) {
      const {lines} = analyzeCommand(
        `git push origin feat/x ${op}${sub} --force`,
        repository,
      );
      assert.ok(
        lines.includes('git push origin feat/x --force'),
        `${op}${sub}: ${JSON.stringify(lines)}`,
      );
    }
  }
});

const CASE_BODIES = [
  'git push origin feat/x >(case x in a) cat;; esac) --force',
  'git push origin feat/x >(case x in a) cat;; esac) -f',
  'git push origin feat/x >(case x in a) cat;; esac) --delete',
  '/usr/bin/git push origin feat/x >(case x in a) cat;; esac) --force',
  '/usr/bin/git push origin feat/x >(case x in a) cat;; esac) --delete',
  "bash -c 'git push origin feat/x >(case x in a) cat;; esac) --force'",
  "bash -c 'git push origin feat/x >(case x in a) cat;; esac) -f'",
  "eval 'git push origin feat/x >(case x in a) cat;; esac) --force'",
  'git push origin feat/x <(case x in a|b) cat;; (c) cat;; esac) --force',
  'git push origin feat/x >(echo ")") --force',
  "git push origin feat/x >(echo ')') --force",
];

test('a case pattern inside a substitution does not end it early', async () => {
  await expectAll(CASE_BODIES, 'DENY');
});

test('unterminated or unbalanced substitutions fail closed', async () => {
  await expectAll(
    [
      'git push origin feat/x >(cat --force',
      'git push origin feat/x >(echo " --force',
      "git push origin feat/x >(echo ' --force",
      'git push origin feat/x $(cat --force',
    ],
    'DENY',
  );
  // main allows this: a substitution that never ends is a syntax error.
  assert.equal(await verdict("bash -c '>(cat --force'"), 'ALLOW');
});

test('the scanner flags what it is unsure of', () => {
  const uncertain = (command: string) => {
    const mode: ShellMode = {legacy: false, uncertain: false};
    parseSegments(command, mode);
    return mode.uncertain;
  };
  for (const command of [
    'diff <(sort a) <(sort b)',
    'git push origin x >(cat) --force',
    'echo >(case x in a) cat;; esac)',
    'echo $(case x in a) cat;; esac)',
    'echo $(cat',
    'echo "unterminated',
    "echo 'unterminated",
    'echo a) b',
    'case x in a) echo hi;; esac',
    'echo a >>>>(cat)',
  ]) {
    assert.equal(uncertain(command), true, command);
  }
  for (const command of [
    'git push origin feat/x',
    'echo "a (b)" > out.txt',
    'echo $(date) && ls',
    'cat <<EOF\n(\nEOF',
    'ls 2>&1 | head',
    'git push 2>&1 && echo "done"',
  ]) {
    assert.equal(uncertain(command), false, command);
  }
});

test('fail-closed analysis carries the first scanner reading', () => {
  const plain = analyzeCommand('git push origin feat/x', repository);
  assert.equal(plain.legacy, undefined);

  const analysis = analyzeCommand(
    'git push origin feat/x >(cat) --force',
    repository,
  );
  assert.ok(analysis.legacy);
  assert.deepEqual(analysis.legacy.canonical.split('\n'), [
    'git push origin feat/x',
    'cat',
    '--force',
  ]);
  assert.ok(analysis.decisions.some(d => d.verdict === 'deny'));
});

test('ordinary uses of the same syntax stay allowed', async () => {
  await expectAll(
    [
      'diff <(sort a) <(sort b)',
      'git push origin feat/x 2> >(cat)',
      'git push origin feat/x 2> >(tee err.log >&2)',
      'tee >(gzip > a.gz) < in',
      'comm -3 <(sort a) <(sort b) > out',
      'git diff <(git show a:f) <(git show b:f)',
      'echo $(case x in a) y;; esac)',
      'ls >/dev/null 2>&1',
      'cmd &>/dev/null',
      'echo hi >| out',
      'cat <<<"hello"',
      'git push -u origin feat/x && [ -f build.log ] && echo ok',
    ],
    'ALLOW',
  );
});

// Sophie's rule: a command the scanner is unsure of is also read the way main
// read it, and the stricter verdict wins. Main's push rules let a flag-like
// word after `&&` count, so with a substitution present they still do.
test('fail closed: an uncertain command is never looser than main', async () => {
  assert.equal(
    await verdict('git push -u origin feat/x && [ -f build.log ] && echo ok'),
    'ALLOW',
  );
  assert.equal(
    await verdict(
      'git push -u origin feat/x >(cat) && [ -f build.log ] && echo ok',
    ),
    'DENY',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';

// Any runner word in a segment (npm, pnpm, yarn, npx, lerna, changeset, also
// `name@version` or a path) starts a command the classifier reads, so no
// wrapper needs listing. Commands are only parsed, never run.

const denies = (command: string) =>
  analyzeCommand(command, import.meta.dirname).decisions.some(decision =>
    /package publish/u.test(decision.reason),
  );
const PUBLISHES = [
  'npm publish',
  'npm --loglevel=x publish',
  'npx lerna@7 publish',
  'npx -y changeset publish',
  'pnpm -r publish',
  'yarn npm publish',
  'lerna publish',
  'changeset publish',
  './node_modules/.bin/lerna publish',
  'npm pub',
];
const BENIGN = [
  'npm install',
  'npm run build',
  'npm help publish',
  'npm -v',
  'git status',
  'grep -c "lerna publish" README.md',
  'rg "npm publish" docs',
  'git commit -m "docs: npm publish notes"',
  'sort -c file',
  'git -c core.x=y status',
];
const PLAIN_WRAPPERS = [
  'nohup',
  'command',
  'builtin',
  'setsid',
  'env A=1',
  'nohup env A=1',
  'nohup env',
  'command env',
  'nohup nohup env',
  'sudo -u x',
  'exec -a x',
  'busybox',
  'xvfb-run -a',
  'dbus-run-session --',
  'proxychains',
  'torify',
  'firejail',
  'bwrap --dev-bind / /',
  'sg grp',
  'valgrind',
  'ltrace',
  'perf record',
  'gdb --args',
  'cpulimit -l 50 --',
  'chronic',
  'ts',
  'volta run',
  'mise exec --',
  'asdf exec',
  'nvm exec 18',
  'fnm exec',
  'direnv exec .',
  'dotenv --',
  'cross-env A=1',
  'doppler run --',
  'aws-vault exec x --',
  'corepack',
];
const SCRIPT_WRAPPERS = [
  "sh -c '%'",
  "bash -lc '%'",
  "ksh -c '%'",
  "fish -c '%'",
  "busybox sh -c '%'",
  "eval '%'",
  "command eval '%'",
  "command sh -c '%'",
  "setsid bash -c '%'",
  "nohup env A=1 sh -c '%'",
  "su -c '%' x",
  "script -qc '%' /dev/null",
  "ssh host '%'",
];
const CONTEXTS = [
  '%',
  'if true; then %; fi',
  '{ %; }',
  'f() { %; }; f',
  'while true; do %; done',
  '! %',
  'echo ok && %',
  '$(%)',
];
const put = (template: string, command: string) =>
  template.replace('%', () => command);

test('round 5: no wrapper hides a publish, listed or not', () => {
  for (const context of CONTEXTS)
    for (const publish of PUBLISHES) {
      for (const wrapper of PLAIN_WRAPPERS) {
        const command = put(context, `${wrapper} ${publish}`);
        assert.equal(denies(command), true, command);
      }
      for (const wrapper of SCRIPT_WRAPPERS) {
        const command = put(context, put(wrapper, publish));
        assert.equal(denies(command), true, command);
      }
    }
});

test('round 5: the forms Code Reviewer found', () => {
  for (const command of [
    'nohup env A=1 npx lerna@7 publish',
    'nohup env npm --loglevel=x publish',
    'command env npm --loglevel=x publish',
    "command sh -c 'lerna publish'",
    "setsid bash -c 'lerna publish'",
    "command eval 'lerna publish'",
    'nohup nohup env npm publish',
    "if true; then sh -c 'lerna publish'; fi",
    "{ bash -c 'lerna publish'; }",
    "f() { sh -c 'lerna publish'; }; f",
    "while true; do eval 'lerna publish'; done",
    'gdb --args npm publish',
    'echo npm publish',
  ])
    assert.equal(denies(command), true, command);
});

test('round 5: quoted text and tools that are not runners are left alone', () => {
  for (const context of CONTEXTS)
    for (const command of BENIGN) {
      const full = put(context, command);
      assert.equal(denies(full), false, full);
    }
});

test('round 5: help and version stay allowed where npm is the command', () => {
  for (const command of [
    'npm help publish',
    'npm -h publish',
    'npm --help publish',
    'npm -v publish',
    'npm --version publish',
    'FOO=1 npm help publish',
    'time npm help publish',
    'if true; then npm help publish; fi',
    'nohup npm help publish',
  ])
    assert.equal(denies(command), false, command);
  for (const command of [
    'npm publish --help',
    'npm publish -h',
    'npm publish --dry-run',
    'npm --registry -v publish',
  ])
    assert.equal(denies(command), true, command);
});

// The fastest of three runs, so a busy CI machine does not fail the test.
function ms(run: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

test('round 6: commands of every size are read in linear time', () => {
  const cases = [
    `env -Z ${'flock '.repeat(6000)}`,
    `time -Z ${'flock '.repeat(3000)}`,
    'flock '.repeat(40_000),
    `npm install ${'npm install '.repeat(20_000)}`,
    `npm install ${'x '.repeat(40_000)}`,
    `sh -c '${'npm install; '.repeat(5000)}'`,
    `ssh host 'npm install${' '.repeat(40_000)}'`,
  ];
  // These take 2-25 ms. The old cubic scan took 2-12 s, a 100x regression
  // fails at 250 ms, and a 10x one at about the same bound.
  for (const command of cases)
    assert.ok(
      ms(() => denies(command)) < 250,
      `${command.slice(0, 30)} took too long`,
    );
  // Four times the input takes about four times as long, not sixteen.
  const small = ms(() => denies('flock '.repeat(10_000)));
  const large = ms(() => denies('flock '.repeat(40_000)));
  assert.ok(large < 10 * Math.max(small, 5), `${small} ms then ${large} ms`);
});

test('round 5: a command too large to read is denied when it has a runner word and publish text', () => {
  const filler = 'x '.repeat(2000);
  for (const [command, expected] of [
    [`npm install ${filler}publish`, true],
    [`npx ${filler}lerna publish`, true],
    [`npm ${filler}pub`, true],
    [`echo ${filler}publish`, false],
    [`npm install ${filler}`, false],
    [`${'flock '.repeat(2000)}publish`, false],
    [`sh -c '${filler}'; npm publish`, true],
  ] as const)
    assert.equal(denies(command), expected, command.slice(-40));
});

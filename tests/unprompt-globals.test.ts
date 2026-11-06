import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectNotExempt, expectVerdicts} from './helpers/verdict.ts';

// The Git exemptions apply only when the sole options before the subcommand
// are `-C` with a plain literal path. Any other option, a quoted or computed
// `-C` path keeps main's verdict.
const CLASSES = ['merge feat/x', 'config user.name'];

test('-C with a plain literal path keeps the Git exemptions', async t => {
  const prefixes = ['', '-C /', '-C repo', '-C / -C x'];
  await expectVerdicts(
    'ALLOW',
    [
      ...prefixes.flatMap(p => CLASSES.map(c => `git ${p} ${c}`)),
      'git -C / checkout --detach HEAD~1',
    ],
    fixture(t),
  );
  // A quoted path is not plain, so the command is read as written.
  expectNotExempt(
    ["-C '/a b'", '-C "/a b"', "-C 'repo'"].flatMap(p =>
      CLASSES.map(c => `git ${p} ${c}`),
    ),
    fixture(t),
  );
});

test('computed -C paths and other global options keep main verdicts', async t => {
  const prefixes = [
    '-C $VAR',
    '-C "$VAR"',
    '-C ~/x',
    '-C `pwd`',
    '-C $(pwd)',
    '-C *',
    '-c core.editor=x',
    "'-c' core.editor=x",
    '"-c" \'core.editor=x\'',
    '-ccore.editor=x',
    '\\-c x=y',
    '--config-env=a.b=C',
    '--work-tree=/',
    "'--work-tree' /",
    '"--work-tree=/"',
    '--git-dir /x/.git',
    "'--git-dir=/x'",
    '--exec-path=/tmp',
    "'--exec-path=/tmp'",
    '"--exec-path" ',
    '--namespace x',
    '--no-pager',
    '-P',
    '--no-optional-locks',
  ];
  await expectVerdicts(
    'ASK',
    [
      ...prefixes.flatMap(p => CLASSES.map(c => `git ${p} ${c}`)),
      'git -c x=y checkout --detach README.md',
      "git '--work-tree=/' checkout --detach README.md",
      'git "--exec-path=/t" checkout --detach README.md',
      'git -C "$V" checkout --detach README.md',
    ],
    fixture(t),
  );
});

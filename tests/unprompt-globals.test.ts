import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// EL-115 PR6: the Git classes apply only when the sole options before the
// subcommand are `-C <literal path>`. Any other option, in any quoting, or a
// computed `-C` path keeps main's verdict.
const CLASSES = ['merge feat/x', 'config user.name'];

test('-C with any literal path keeps the Git classes', async t => {
  const prefixes = [
    '',
    '-C /',
    '-C repo',
    "-C '/a b'",
    '-C "/a b"',
    '-C / -C x',
  ];
  await expectVerdicts(
    'ALLOW',
    [
      ...prefixes.flatMap(p => CLASSES.map(c => `git ${p} ${c}`)),
      'git -C / checkout --detach HEAD~1',
    ],
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

import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// P16-F3: the canonical text joins the lines of `git; -C x merge main` with a
// newline, which the text rules read as the whitespace of `git -C x merge`.
// A bare `git` segment or an option-like command word keeps main's verdict.
test('a bare git segment before an option-like word keeps the ask', async t => {
  const cwd = fixture(t);
  await expectVerdicts(
    'ASK',
    [
      'git; -C x merge main',
      'git && -C x merge main',
      'git | -C x merge main',
      'git\n-C x merge main',
      '/usr/bin/git; -C x merge main',
      'git; -C x checkout --detach HEAD~1',
      'git; -C x config --get a.b',
      'git -C sub merge x; -C y',
    ],
    cwd,
  );
});

test('literal git -C merge and plain merge behave as before', async t => {
  const cwd = fixture(t);
  await expectVerdicts(
    'ALLOW',
    [
      'git -C sub merge x',
      'git -C sub merge feat/x',
      'git merge feat/x',
      'git status; git merge feat/x',
    ],
    cwd,
  );
});

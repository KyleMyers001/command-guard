import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// EL-115 PR6: `git checkout --detach` never prompts for a literal commit.
// Git refuses `--detach <path>`, so the operand cannot overwrite a file.
// Forced, dynamic and path-separated forms keep their main verdicts.
function repo(t: Parameters<typeof fixture>[0]): string {
  const cwd = fixture(t);
  mkdirSync(join(cwd, 'docs'));
  for (const name of ['README.md', 'package.json', 'Makefile'])
    writeFileSync(join(cwd, name), 'synthetic');
  return cwd;
}

test('git checkout --detach of a literal commit is allowed', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'git checkout --detach',
      'git checkout --detach HEAD',
      'git checkout --detach HEAD~1',
      'git checkout --detach main',
      'git checkout --detach v1.2.3',
      'git checkout --detach origin/main',
      'git checkout --detach origin/feature.x',
      'git checkout --detach release/1.2.x',
      'git checkout --detach v1.2.3.rc',
      'git checkout --detach 1a2b3c4d',
      'git checkout --detach package.json',
      'git checkout --detach README.md',
      'git checkout --detach docs',
      'git checkout -q --detach origin/main',
      'git checkout --detach --quiet origin/main',
      'git -C repo checkout --detach origin/feature.x',
    ],
    repo(t),
  );
});

test('forced, dynamic and path forms keep main verdicts', async t => {
  const cwd = repo(t);
  await expectVerdicts(
    'ASK',
    [
      'git checkout --detach "$REF"',
      'git checkout --detach $REF',
      'git checkout --detach "$(git rev-parse HEAD)"',
      'git checkout --detach -- README.md',
      'git checkout --detach HEAD -- README.md',
      'git checkout --detach HEAD README.md',
      'git checkout --detach HEAD main',
      'git checkout --detach -f HEAD',
      'git checkout --detach --force origin/main',
      'git checkout --detach -m origin/main',
      'git checkout --detach --merge origin/main',
      'git checkout --detach -p HEAD',
      'git checkout --detach --ours package.json',
      'git checkout --detach --pathspec-from-file=f',
      // A directory or work tree that cannot be established keeps asking.
      'git -C "$REPO" checkout --detach origin/main',
      'git -C "$REPO" checkout --detach origin/feature.x',
      'git --work-tree="$W" checkout --detach HEAD',
      'git --work-tree=/ checkout --detach v1.0',
      'cd "$DIR" && git checkout --detach origin/main',
      'git --git-dir="$G" --work-tree=. checkout --detach origin/main',
      // Not --detach: operands that may be paths still ask.
      'git checkout origin/feature.x',
      'git checkout package.json',
      'git checkout README.md',
      'git checkout ./README.md',
      'git checkout docs/',
      'git checkout -f main',
      'git checkout -- README.md',
      'git checkout HEAD -- README.md',
      'git checkout "$REF"',
      'git -C "$REPO" checkout main',
      'git checkout --det README.md',
      'git checkout -d README.md',
      "git checkout --detach --quiet$(printf ' --force') release.v1",
      'git checkout --detach $OPTS release.v1',
      'git checkout "--detach$X" release.v1',
    ],
    cwd,
  );
  await expectVerdicts(
    'DENY',
    [
      'git checkout --detach origin/main && git push --force origin f',
      'git checkout --detach origin/main && git push origin main',
      'git checkout --detach HEAD~5 && git reset --hard',
    ],
    cwd,
  );
});

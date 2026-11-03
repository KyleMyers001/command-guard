import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// EL-115 PR6: local Git commands that only read or only move the current
// branch no longer prompt. Pushes, history rewrites and force options keep
// their verdicts. Verdicts come from the shipped policy; nothing is executed.
test('local git merge is allowed', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'git merge feat/x',
      'git merge origin/main',
      'git merge main',
      'git merge --no-ff feat/x',
      'git merge --ff-only origin/main',
      'git merge --squash feat/x',
      'git merge -m "merge x" feat/x',
      'git merge -s ours feat/x',
      'git merge -X theirs feat/x',
      'git merge --no-commit feat/x',
      'git merge --allow-unrelated-histories feat/x',
      'git merge',
      'git -C repo merge feat/x',
      'git --no-pager merge feat/x',
      'git -P -C repo merge feat/x',
      'git fetch origin && git merge origin/main',
      'git merge --abort',
      'git merge --continue',
      'git merge --quit',
    ],
    fixture(t),
  );
});

test('merge hook bypass and pushes after a merge keep main verdicts', async t => {
  const cwd = fixture(t);
  await expectVerdicts(
    'ASK',
    [
      'git merge --no-verify feat/x',
      'git merge feat/x --no-verify',
      'git merge --no-ff --no-verify feat/x',
      'git -C repo merge --no-verify feat/x',
      'git merge --no-verify-signatures feat/x',
      // Global options that can run code or move the work tree keep asking.
      'git -c core.editor=sh merge feat/x',
      'git -c merge.x.driver=sh merge feat/x',
      'git -c user.name=x merge feat/x',
      'git --git-dir=/elsewhere merge feat/x',
      'git --work-tree=/ merge feat/x',
      'git --exec-path=/elsewhere merge feat/x',
      'git -C repo -c core.editor=sh merge feat/x',
      'git commit --amend --no-edit',
      'git rebase main',
      'git branch -D old',
      'git tag -d v1',
      'git merge feat/x && gh pr merge 3',
    ],
    cwd,
  );
  await expectVerdicts(
    'DENY',
    [
      'git merge feat/x && git push origin main',
      'git merge feat/x; git push origin master',
      'git merge feat/x && git push --force origin feat/x',
      'git merge feat/x && git push origin +feat/x',
      'git merge feat/x && git push origin --delete feat/x',
      'git merge feat/x && git push',
      'git merge feat/x && git reset --hard HEAD~3',
      'git merge feat/x && git filter-repo --path x',
    ],
    cwd,
  );
});

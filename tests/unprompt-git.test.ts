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
      // Quoted option values, expansions and env prefixes can hide code or
      // flags, so they keep asking.
      "git -c core.editor='touch /tmp/marker' merge --edit feat/x",
      'git -c core.editor="touch /tmp/marker" merge feat/x',
      'MERGE_FLAGS=--no-verify; git merge $MERGE_FLAGS feat/x',
      'git merge $MERGE_FLAGS feat/x',
      'git merge `echo --no-verify` feat/x',
      "git merge -m 'a;b' $MERGE_FLAGS feat/x",
      "GIT_EDITOR='touch /tmp/marker' git merge --edit feat/x",
      'env GIT_EDITOR=sh git merge --edit feat/x',
      'git -C "$DIR" merge feat/x',
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

test('git config reads are allowed', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'git config user.name',
      'git config user.email',
      'git config remote.origin.url',
      'git config --global user.name',
      'git config --local core.autocrlf',
      'git config --system --get core.editor',
      'git config --global --get user.name',
      'git config --local --get remote.origin.url',
      'git config --get-all remote.origin.fetch',
      'git config --global --get-all url.x.insteadOf',
      'git config --show-origin --get-regexp remote',
      'git config --global --list',
      'git config --local --list',
      'git config --show-origin --show-scope --list',
      'git config -l',
      'git config --get remote.origin.url',
      'git config --list',
      'git -C repo config user.name',
      'git config user.name && git config user.email',
      'git config',
    ],
    fixture(t),
  );
});

test('git config writes and file options keep main verdicts', async t => {
  await expectVerdicts(
    'ASK',
    [
      'git config user.name Bob',
      'git config --global user.name Bob',
      'git config --global user.name ""',
      'git config user.name "Bob Smith"',
      'git config --unset user.name',
      'git config --global --unset user.name',
      'git config --unset-all remote.origin.fetch',
      'git config --add remote.origin.fetch x',
      'git config --replace-all a.b c',
      'git config --global --remove-section user',
      'git config --rename-section a b',
      'git config -e',
      'git config --global -e',
      'git config --edit',
      'git config --global',
      'git config --global --get-regexp ^remote',
      'git config -f ~/.ssh/id_rsa --list',
      'git config --file x user.name',
      'git config --global --file x user.name',
      'git config --blob HEAD:x --list',
      'git config --global user.name $NAME',
      'git config --global user.name; git config --global user.email x@y',
      'git config --global user.name\ngit config --global user.email x@y',
      'git config --global alias.x "!rm -rf /"',
      'git config --global credential.helper store',
      'git config remote.origin.url https://evil.test/x.git',
      'git config --global core.sshCommand "ssh -i x"',
      'git config a.b=c',
      'git config --global --get user.name Bob',
    ],
    fixture(t),
  );
  await expectVerdicts(
    'DENY',
    [
      'git config core.hooksPath x',
      'git config --global core.hooksPath x',
      'git config --get core.hooksPath',
      'git config core.hooksPath',
    ],
    fixture(t),
  );
});

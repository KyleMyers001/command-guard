import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test, {after, before} from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {parseSegments} from '../extensions/command-guard/shell.ts';

// Command strings are only ever parsed, never executed.
// Shared layout is read-only once populated. Keep setup runner-managed so its
// teardown runs even if population fails (module-evaluation failures skip it).
let cwd: string;
let cleanup: (() => void) | undefined;
after(() => cleanup?.());
before(() => {
  cwd = fixture({
    after: callback => {
      cleanup = callback;
    },
  });
  mkdirSync(join(cwd, 'docs'));
  mkdirSync(join(cwd, 'nested/sub'), {recursive: true});
  writeFileSync(join(cwd, 'Makefile'), 'synthetic');
  writeFileSync(join(cwd, 'nested/README'), 'synthetic');
  // Present only inside `repo`, so a check against `cwd` alone misses them.
  mkdirSync(join(cwd, 'repo/src'), {recursive: true});
  writeFileSync(join(cwd, 'repo/Justfile'), 'synthetic');
  mkdirSync(join(cwd, 'repo/git'));
  writeFileSync(join(cwd, 'repo/git/Taskfile'), 'synthetic');
});

const texts = (command: string) =>
  parseSegments(command).map(words => words.map(word => word.text));

function verdict(command: string): 'deny' | 'ask' | 'allow' {
  const {decisions} = analyzeCommand(command, cwd);
  if (decisions.some(decision => decision.verdict === 'deny')) return 'deny';
  return decisions.length > 0 ? 'ask' : 'allow';
}

function expectVerdicts(
  expected: 'deny' | 'ask' | 'allow',
  commands: string[],
) {
  const wrong = commands
    .map(command => [command, verdict(command)])
    .filter(([, actual]) => actual !== expected)
    .map(
      ([command, actual]) => `${command} -> ${actual}, expected ${expected}`,
    );
  assert.deepEqual(wrong, []);
}

test('decoding: quotes and escapes yield literal words', () => {
  assert.deepEqual(texts("git push origin 'main'"), [
    ['git', 'push', 'origin', 'main'],
  ]);
  assert.deepEqual(texts('git push origin "ma"in'), [
    ['git', 'push', 'origin', 'main'],
  ]);
  assert.deepEqual(texts('git push origin ma\\in'), [
    ['git', 'push', 'origin', 'main'],
  ]);
  assert.deepEqual(texts('echo "a\\"b" \'c d\' "" e\\ f'), [
    ['echo', 'a"b', 'c d', '', 'e f'],
  ]);
  assert.deepEqual(texts('echo "keep\\n"'), [['echo', 'keep\\n']]);
  assert.deepEqual(texts('git \\\n  push\torigin   feat/x'), [
    ['git', 'push', 'origin', 'feat/x'],
  ]);
  assert.ok(
    parseSegments("git push origin 'main'")[0].every(word => !word.dynamic),
  );
});

test('decoding: separators split segments only outside quotes', () => {
  assert.deepEqual(texts('a && b; c | d || e\nf & g'), [
    ['a'],
    ['b'],
    ['c'],
    ['d'],
    ['e'],
    ['f'],
    ['g'],
  ]);
  assert.deepEqual(texts('echo \'a; b\' "c && d"'), [
    ['echo', 'a; b', 'c && d'],
  ]);
  assert.deepEqual(texts('(cd repo && git status)'), [
    ['cd', 'repo'],
    ['git', 'status'],
  ]);
  assert.deepEqual(texts('git status # git push origin main\nls'), [
    ['git', 'status'],
    ['ls'],
  ]);
  assert.deepEqual(texts('echo a#b'), [['echo', 'a#b']]);
});

test('decoding: expansions are marked dynamic, literal quoting is not', () => {
  const dynamic = (command: string) => {
    const segment = parseSegments(command).at(-1);
    assert.ok(segment);
    return segment.map(word => word.dynamic);
  };
  assert.deepEqual(dynamic('git push origin $BRANCH'), [
    false,
    false,
    false,
    true,
  ]);
  assert.deepEqual(dynamic('git push origin "feat/$NAME"'), [
    false,
    false,
    false,
    true,
  ]);
  assert.deepEqual(dynamic("git push origin '$BRANCH'"), [
    false,
    false,
    false,
    false,
  ]);
  assert.deepEqual(dynamic('git push origin feat/*'), [
    false,
    false,
    false,
    true,
  ]);
  assert.deepEqual(dynamic("git push origin 'feat/*'"), [
    false,
    false,
    false,
    false,
  ]);
  assert.deepEqual(dynamic('git push origin {main,x}'), [
    false,
    false,
    false,
    true,
  ]);
  assert.deepEqual(dynamic("git push origin $'main'"), [
    false,
    false,
    false,
    true,
  ]);
  assert.deepEqual(dynamic("git push origin 'unterminated"), [
    false,
    false,
    false,
    true,
  ]);
  assert.deepEqual(dynamic('git push origin "unterminated'), [
    false,
    false,
    false,
    true,
  ]);
});

test('decoding: redirections are not arguments', () => {
  assert.deepEqual(texts('git push origin feat/x 2>&1 | tail -5'), [
    ['git', 'push', 'origin', 'feat/x'],
    ['tail', '-5'],
  ]);
  assert.deepEqual(texts('git push origin feat/x >out.txt 2> err.txt'), [
    ['git', 'push', 'origin', 'feat/x'],
  ]);
  assert.deepEqual(texts('git push origin feat/x &> /dev/null'), [
    ['git', 'push', 'origin', 'feat/x'],
  ]);
  assert.deepEqual(texts('sort < in.txt >> out.txt; wc -l <<< text'), [
    ['sort'],
    ['wc', '-l'],
  ]);
});

test('decoding: substitutions are inspected as commands of their own', () => {
  const inner = ['git', 'push', 'origin', 'main'];
  assert.deepEqual(
    texts('echo $(git push origin main)').filter(words => words[0] === 'git'),
    [inner],
  );
  assert.deepEqual(
    texts('echo "x $(git push origin main) y"').filter(
      words => words[0] === 'git',
    ),
    [inner],
  );
  assert.deepEqual(
    texts('echo `git push origin main`').filter(words => words[0] === 'git'),
    [inner],
  );
  assert.deepEqual(
    texts('echo "`git push origin main`"').filter(words => words[0] === 'git'),
    [inner],
  );
  assert.deepEqual(
    texts('echo "$(echo "$(git push origin main)")"').filter(
      words => words[0] === 'git',
    ),
    [inner],
  );
  assert.deepEqual(
    texts('diff <(git push origin main) x').filter(words => words[0] === 'git'),
    [inner],
  );
  assert.throws(() => parseSegments('$('.repeat(40)));
});

test('decoding: here-document bodies are data', () => {
  assert.deepEqual(
    texts("cat <<'EOF'\ngit push origin main\n`git push`\nEOF\necho done"),
    [['cat'], ['echo', 'done']],
  );
  assert.deepEqual(
    texts('cat <<-EOF\n\tgit push origin main\n\tEOF\necho done'),
    [['cat'], ['echo', 'done']],
  );
  assert.deepEqual(texts('cat <<A <<B\none\nA\ntwo\nB\necho done'), [
    ['cat'],
    ['echo', 'done'],
  ]);
  const body =
    'gh pr create --body "$(cat <<\'EOF\'\nRun `git push origin main` never.\nEOF\n)"';
  assert.deepEqual(
    texts(body).filter(words => words[0] === 'git'),
    [],
  );
});

test('decoding stays linear on very large commands', () => {
  const started = performance.now();
  parseSegments('echo start; ' + 'git status && '.repeat(40_000) + 'true');
  parseSegments("cat <<'X'\n" + 'alpha beta gamma\n'.repeat(60_000) + 'X');
  analyzeCommand("printf '" + 'x '.repeat(200_000) + "'", cwd);
  assert.ok(performance.now() - started < 1_000);
});

test('push: explicit literal feature destinations are allowed', () => {
  expectVerdicts('allow', [
    'git push -u origin feat/example',
    'git push --set-upstream origin feat/example',
    'git push origin HEAD:refs/heads/feat/example',
    'git push origin HEAD:feat/example',
    'git push origin refs/heads/feat/example',
    "git push origin 'feat/example'",
    'git push "origin" "feat/example"',
    'git push origin feat/a feat/b',
    'git -C /tmp/repo push origin feat/example',
    'git -C "$REPO" push origin feat/example',
    'git -c user.name=x --no-pager push origin feat/example',
    '/usr/bin/git push -uv origin feat/example',
    'git push --dry-run --verbose origin feat/example',
    'git push origin main:feat/copy',
    // A full ref names the branch `heads/main`, not an abbreviation of main.
    'git push origin HEAD:refs/heads/heads/main',
    'git push origin HEAD:heads/feat/example',
    'git push origin feat/maintenance',
    'git push origin feat/release-notes',
    'git push origin production-fix',
    'git push origin v1.2.3',
    'cd repo && git push -u origin feat/example 2>&1 | tail -3',
    'git push origin -- feat/example',
    'git push --help',
    "git commit -m 'docs: never git push origin main'",
    'git log --oneline -5 && git status',
  ]);
});

test('push: protected destinations deny regardless of spelling', () => {
  expectVerdicts('deny', [
    'git push origin main',
    "git push origin 'main'",
    'git push origin "main"',
    'git push origin ma\\in',
    "git push origin m'ai'n",
    'git push origin Main',
    'git push origin HEAD:main',
    'git push origin HEAD:refs/heads/main',
    'git push origin HEAD:"refs/heads/main"',
    'git push origin refs/heads/master',
    // Git expands `heads/main` to `refs/heads/main` on the remote.
    'git push origin HEAD:heads/main',
    'git push origin HEAD:heads/master',
    'git push origin HEAD:heads/production',
    'git push origin HEAD:"heads/main"',
    'git push origin heads/release',
    'git push origin feat/example HEAD:heads/main',
    'git push origin feat/example:master',
    'git push origin feat/example main',
    'git push -u origin prod',
    'git push origin production',
    'git push origin release',
    'git push origin main --dry-run',
    'git -C /tmp/repo push origin main',
    'git --git-dir=/tmp/repo/.git push origin main',
    'git --git-dir /tmp/repo/.git push origin main',
    '/usr/bin/git push origin main',
    'env GIT_TRACE=1 git push origin main',
    'GIT_TRACE=1 git push origin main',
    'time git push origin main',
    'git $OPTIONS push origin main',
    'git push origin feat/example && git push origin main',
    "git push origin feat/example; git push origin 'main'",
    'echo "$(git push origin main)"',
    "bash -lc 'git push origin main'",
    'sh -c "git push origin main"',
    'eval git push origin main',
  ]);
});

test('scripts: supported wrappers and shell option bundles are inspected', () => {
  expectVerdicts('deny', [
    "env CI=1 bash -lc 'git push origin main'",
    "bash -cl 'git push origin main'",
    "CI=1 bash -c 'git push origin main'",
    'CI=1 DEBUG="$LEVEL" bash -c \'git push origin main\'',
    'env CI=1 DEBUG="$LEVEL" bash -c \'git push origin main\'',
    "time bash -c 'git push origin main'",
    "time -p env -i CI=1 /bin/bash -c 'git push origin main'",
    "env -u NAME bash -c 'git push origin main'",
    "bash -l -c 'git push origin main'",
    "bash -c -l 'git push origin main'",
    "bash -o pipefail -c 'git push origin main'",
    "bash --noprofile --norc -c 'git push origin main'",
    "zsh -ic 'git push origin main'",
    'bash -c "bash -cl \'git push origin main\'"',
    'env CI=1 eval git push origin main',
    "git status && env CI=1 bash -lc 'git push origin main'",
  ]);
  expectVerdicts('allow', [
    "env CI=1 bash -lc 'git push -u origin feat/example'",
    "bash -cl 'git status'",
    "time bash -c 'ls -la'",
    "CI=1 sh -c 'npm test'",
    'bash --version',
    'bash --help',
    'bash -c',
    'bash script.sh',
    'bash -l script.sh -c',
    'bash "$SCRIPT_FILE"',
    'env CI=1 npm test',
    'echo "bash -c \'git push origin main\'"',
    'rg bash -c src',
  ]);
  expectVerdicts('ask', [
    "env CI=1 bash -lc 'git checkout src/index.ts'",
    "time sh -c 'git checkout -- file.ts'",
  ]);
});

test('scripts: what cannot be inspected never passes silently', () => {
  expectVerdicts('deny', [
    'bash -c "$SCRIPT"',
    'bash -c "git status; $REST"',
    'env CI=1 sh -c "$(cat script.sh)"',
    "bash -c 'unterminated",
    // An option of the wrapper that the guard does not know.
    "env --split-string bash -c 'git status'",
    "time --verbose bash -c 'git status'",
    // A command string beyond the inspection depth.
    'eval eval eval eval git status',
  ]);
  expectVerdicts('ask', ['eval "$(fnm env)"', 'eval "$SETUP"']);
  expectVerdicts('allow', [
    'eval eval git status',
    'env --split-string printf x',
  ]);
});

test('push: force, deletion, and bulk forms deny', () => {
  expectVerdicts('deny', [
    'git push -f origin feat/example',
    'git push -fu origin feat/example',
    'git push -uf origin feat/example',
    'git push --force origin feat/example',
    'git push origin feat/example --force',
    'git push --force-with-lease origin feat/example',
    'git push --force-with-lease=feat/example origin feat/example',
    'git push --force-if-includes origin feat/example',
    'git push origin +feat/example',
    "git push origin '+feat/example'",
    'git -C /tmp/repo push --force origin feat/example',
    'git -C /tmp/repo push origin +HEAD:refs/heads/feat/example',
    'git push origin --delete feat/example',
    'git push -d origin feat/example',
    'git push origin :feat/example',
    'git push --mirror',
    'git push --mirror origin',
    'git push --all origin',
    'git push --branches origin',
    'git push --prune origin feat/example',
    "git push origin 'refs/heads/*:refs/heads/*'",
    'git push origin :',
  ]);
});

test('push: implicit, dynamic, and unanalyzed forms deny', () => {
  expectVerdicts('deny', [
    'git push',
    'git push origin',
    'git push -u origin',
    'git push origin HEAD',
    'git push -u origin HEAD',
    'git push origin @',
    'git push origin feat/example:',
    'git push origin a:b:c',
    'git push origin "$BRANCH"',
    'git push origin $BRANCH',
    'git push "$REMOTE" feat/example',
    'git push origin $(git branch --show-current)',
    'git push origin `git branch --show-current`',
    'git push origin feat/*',
    'git push origin feat/{a,b}',
    "git push origin 'unterminated",
    'git push --no-verify origin feat/example',
    'git push -o ci.skip origin feat/example',
    'git push --push-option=ci.skip origin feat/example',
    'git push --repo=elsewhere feat/example',
    'git push --tags origin',
    'git push origin refs/for/main',
    'git push origin refs/tags/v1',
    'git push -x origin feat/example',
  ]);
});

test('checkout: path restoration and ambiguous operands ask', () => {
  expectVerdicts('ask', [
    'git checkout .github/workflows/ci.yml',
    'git checkout src/index.ts',
    'git checkout -- file.ts',
    'git checkout main -- file.ts',
    'git checkout .',
    'git checkout ./src',
    'git checkout src/',
    "git checkout '*.ts'",
    'git checkout "$FILE"',
    'git checkout HEAD~1 src',
    'git checkout -f',
    'git checkout --force main',
    'git checkout -B feat/example',
    'git checkout -fB feat/example',
    'git checkout --ours conflicted',
    'git checkout -p',
    'git checkout --merge main',
    'git checkout --pathspec-from-file=list',
    'git -C /tmp/repo checkout src/index.ts',
    'cd repo && git checkout README.md',
    // Operands that name something in the working directory.
    'git checkout docs',
    'git checkout Makefile',
    'git -C nested checkout README',
    'git -C nested -C sub checkout ../README',
    // Operands that exist only where an earlier `cd` leads.
    'cd repo && git checkout Justfile',
    'cd repo; git checkout src',
    '(cd repo && git checkout Justfile)',
    'cd nested && cd ../repo && git checkout Justfile',
    "bash -c 'cd repo && git checkout Justfile'",
    // A directory named like a tool is still a directory change.
    'cd repo/git && git checkout Taskfile',
    'cd repo && git -C src checkout ../Justfile',
    // Where Git runs is unknown, so a lone operand may be a path.
    'cd "$DIR" && git checkout Justfile',
    'cd ~/repo && git checkout Justfile',
    'cd - && git checkout Justfile',
    'pushd repo && git checkout Justfile',
    'git --work-tree=repo checkout Justfile',
    'git --work-tree repo checkout Justfile',
    'GIT_WORK_TREE=repo git checkout Justfile',
    'git -C "$REPO" checkout Justfile',
  ]);
});

test('checkout: ordinary branch operations stay allowed', () => {
  expectVerdicts('allow', [
    'git checkout',
    'git checkout main',
    'git checkout feat/example',
    'git checkout release/1.2',
    'git checkout v1.2.3',
    'git checkout -',
    'git checkout -b feat/example',
    'git checkout -b feat/example origin/main',
    'git checkout -t origin/feat/example',
    'git checkout --track origin/feat/example',
    'git checkout --detach v1.2.3',
    'git checkout --orphan gh-pages',
    'git checkout -q main',
    'git -C nested checkout docs',
    'cd repo && git checkout main',
    'cd repo && git checkout -b feat/example',
    'cd nested/sub && git checkout Justfile',
    'cd "$DIR" && git checkout -b feat/example',
    'git --work-tree=repo checkout -b feat/example',
    'git switch -c feat/example',
    'git switch main',
  ]);
});

test('restore: only an established staged-only restore is allowed', () => {
  expectVerdicts('ask', [
    'git restore Makefile',
    'git restore .',
    'git restore --staged -W Makefile',
    'git restore -W --staged Makefile',
    'git restore --staged --worktree Makefile',
    'git restore --worktree --staged Makefile',
    'git restore -SW Makefile',
    'git restore -WS Makefile',
    'git restore -qSW Makefile',
    'git restore Makefile --staged -W',
    'git restore --source=HEAD~1 Makefile',
    'git restore -s HEAD~1 Makefile',
    'git -C repo restore -SW Justfile',
    'git restore --staged --patch',
    'git restore --staged --unknown-option Makefile',
    'git restore --staged "$OPTIONS" Makefile',
    'git restore $OPTIONS',
    'git restore',
  ]);
  expectVerdicts('allow', [
    'git restore --staged Makefile',
    'git restore --staged .',
    'git restore -S Makefile',
    'git restore -qS Makefile',
    'git restore Makefile --staged',
    'git restore --staged --source=HEAD Makefile',
    'git restore --staged --source HEAD~1 Makefile',
    'git restore -S -s HEAD~1 Makefile',
    'git restore -SsHEAD~1 Makefile',
    'git -C repo restore --staged Justfile',
    // After `--` every word is a filename, even one spelled like a flag.
    'git restore --staged -- -W',
    'git restore --staged -- "$FILE"',
  ]);
  // The value of --source is not the worktree flag.
  expectVerdicts('allow', ['git restore --staged --source -W Makefile']);
});

test('kubectl: only a single literal client or server dry run is exempt', () => {
  expectVerdicts('ask', [
    'kubectl delete pod example',
    'kubectl delete pod example --dry-run=none',
    'kubectl delete pod example --dry-run',
    'kubectl delete pod example --dry-run client',
    'kubectl delete pod example --dry-run=',
    'kubectl delete pod example --dry-run=client --dry-run=none',
    'kubectl delete pod example --dry-run=none --dry-run=client',
    'kubectl delete pod example --dry-run=client --dry-run=server',
    'kubectl delete pod example --dry-run="$MODE"',
    "kubectl delete pod example '--dry-run=none'",
    'kubectl -n prod rollout restart deploy/example',
    'kubectl rollout undo deploy/example',
    '/usr/local/bin/kubectl apply -f x.yaml',
    'kubectl --context prod scale deploy/example --replicas=0',
    'kubectl get pods --dry-run=client; kubectl delete pod example',
  ]);
  expectVerdicts('allow', [
    'kubectl delete pod example --dry-run=client',
    'kubectl delete pod example --dry-run=server',
    'kubectl apply --dry-run=client -f x.yaml',
    "kubectl apply '--dry-run=server' -f x.yaml",
    'kubectl get pods',
    'kubectl rollout status deploy/example',
    'kubectl describe pod delete-me',
  ]);
});

test('helm: mutations ask because dry-run semantics vary by version', () => {
  expectVerdicts('ask', [
    'helm install example ./chart',
    'helm upgrade example ./chart --dry-run',
    'helm upgrade example ./chart --dry-run=client',
    'helm uninstall example --dry-run=false',
    'helm -n prod rollback example 1',
    'helm delete example',
  ]);
  expectVerdicts('allow', [
    'helm list',
    'helm template example ./chart',
    'helm status example',
  ]);
});

test('canonical spelling drops global options, paths, and needless quotes', () => {
  const canonical = (command: string) => analyzeCommand(command, cwd).canonical;
  assert.equal(
    canonical('gh -R owner/repo pr merge 4 --squash'),
    'gh pr merge 4 --squash',
  );
  assert.equal(canonical('gh --repo owner/repo pr merge 4'), 'gh pr merge 4');
  assert.equal(canonical('gh --repo=owner/repo pr merge 4'), 'gh pr merge 4');
  assert.equal(
    canonical('gh -Rowner/repo pr -R other/repo merge 4'),
    'gh pr merge 4',
  );
  assert.equal(
    canonical('git -C /tmp/repo push --force origin feat/x'),
    'git push --force origin feat/x',
  );
  assert.equal(
    canonical("/usr/bin/git -c a=b --no-pager reset '--hard'"),
    'git reset --hard',
  );
  assert.equal(
    canonical('env X=1 "git" push origin \'main\''),
    'env X=1 git push origin main',
  );
  assert.equal(
    canonical('cd repo && gh -R o/r api -X DELETE repos/o/r'),
    'cd repo\ngh api -X DELETE repos/o/r',
  );
  assert.equal(
    canonical("bash -lc 'gh -R o/r pr merge 4'").split('\n').at(-1),
    'gh pr merge 4',
  );
});

test('canonical spelling separates attached GitHub API flag values', () => {
  const canonical = (command: string) => analyzeCommand(command, cwd).canonical;
  assert.equal(
    canonical('gh api -XPUT repos/o/r/pulls/4/merge'),
    'gh api -X PUT repos/o/r/pulls/4/merge',
  );
  assert.equal(canonical('gh api -X=PUT repos/o/r'), 'gh api -X PUT repos/o/r');
  assert.equal(
    canonical('gh api repos/o/r/issues -ftitle=example'),
    'gh api repos/o/r/issues -f title=example',
  );
  assert.equal(
    canonical('gh api repos/o/r/issues -Fcount=1'),
    'gh api repos/o/r/issues -F count=1',
  );
  assert.equal(
    canonical('gh api -iXPOST repos/o/r/issues'),
    'gh api -i -X POST repos/o/r/issues',
  );
  assert.equal(
    canonical('gh -R o/r api -XDELETE repos/o/r'),
    'gh api -X DELETE repos/o/r',
  );
  assert.equal(
    canonical("/opt/homebrew/bin/gh api '-XDELETE' repos/o/r"),
    'gh api -X DELETE repos/o/r',
  );
  assert.equal(
    canonical('gh api -X"$METHOD" repos/o/r'),
    "gh api -X '$METHOD' repos/o/r",
  );
  assert.equal(canonical('gh api -XGET repos/o/r'), 'gh api -X GET repos/o/r');
  // Separate spellings, other options' values, endpoints, and words after
  // `--` are left as written.
  for (const command of [
    'gh api -X PUT repos/o/r',
    'gh api --method PUT repos/o/r',
    'gh api repos/o/r -f title=-XPUT',
    'gh api -H -XPUT repos/o/r',
    'gh api --jq -ftitle repos/o/r',
    'gh api repos/o/r -- -XPUT',
    'gh api repos/o/-XPUT',
    'gh pr view -XPUT',
    'gh api -Zunknown repos/o/r',
  ]) {
    assert.equal(canonical(command), command);
  }
});

test('canonical spelling keeps unsafe words quoted', () => {
  const canonical = (command: string) => analyzeCommand(command, cwd).canonical;
  assert.equal(
    canonical("git commit -m 'fix: a; npm publish'"),
    "git commit -m 'fix: a; npm publish'",
  );
  assert.equal(canonical('echo "it\'s $HOME"'), "echo 'it'\\''s $HOME'");
  assert.equal(canonical("printf ''"), "printf ''");
});

test('reasons are fixed text that never echoes command content', () => {
  const commands = [
    'git push origin synthetic-private main',
    'git push synthetic-private',
    'git checkout synthetic-private.ts',
    'kubectl delete pod synthetic-private',
    'helm uninstall synthetic-private',
    'git push origin HEAD:heads/main synthetic-private',
    'git restore synthetic-private',
    'bash -c "synthetic-private $X"',
    'eval "synthetic-private $X"',
    'env --synthetic-private bash -c ls',
    'eval eval eval eval synthetic-private',
  ];
  for (const command of commands) {
    const {decisions} = analyzeCommand(command, cwd);
    assert.ok(decisions.length > 0, command);
    for (const decision of decisions)
      assert.ok(
        !decision.reason.includes('synthetic-private'),
        decision.reason,
      );
  }
});

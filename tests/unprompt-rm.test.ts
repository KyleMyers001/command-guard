import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// EL-115 PR6: `rm -r` of a build or output directory inside the repo no
// longer prompts. Every other `rm -r` keeps the verdict it has on main. All
// verdicts are read from the shipped policy; nothing is executed.
test('rm -r of a named build directory in the repo is allowed', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'rm -rf dist',
      'rm -r build',
      'rm -rf out',
      'rm -fr target',
      'rm -Rf coverage',
      'rm -rf .next',
      'rm -rf node_modules',
      'rm -rf ./dist',
      'rm -rf ./node_modules',
      'rm -rf --recursive --force dist',
      'rm --recursive dist',
      'rm -rfv dist',
      'rm -r -f dist build',
      'rm -rf dist build out target node_modules .next coverage',
      'rm -rf dist && npm run build',
      'rm -rf dist; tsc',
      'git add . && rm -rf dist',
      'echo . ; rm -rf dist',
      'npm ci && rm -rf dist | cat',
      'rm -rf dist\ntsc',
      'echo start; rm -rf dist',
    ],
    fixture(t),
  );
});

test('rm -r of anything else still asks or denies as on main', async t => {
  const cwd = fixture(t);
  await expectVerdicts(
    'ASK',
    [
      'rm -rf src',
      'rm -rf dist src',
      'rm -rf src dist',
      'rm -rf / dist',
      'rm -rf dist /',
      'rm -rf distribution',
      'rm -rf dist.bak',
      'rm -rf mybuild',
      'rm -rf .git',
      'rm -rf .',
      'rm -rf ./',
      'rm -rf ..',
      'rm -rf ../dist',
      'rm -rf ../../dist',
      'rm -rf dist/..',
      'rm -rf node_modules/../..',
      'rm -rf node_modules/../../x/dist',
      'rm -rf /tmp/dist',
      'rm -rf /home/user/dist',
      'rm -rf /Users/kyle/project/dist',
      'rm -rf ~/dist',
      'rm -rf ~/project/node_modules',
      'rm -rf $HOME/dist',
      'rm -rf "$HOME/dist"',
      'rm -rf $DIR',
      'rm -rf $DIR/dist',
      'rm -rf "dist"',
      "rm -rf 'dist'",
      'rm -rf `echo dist`',
      'rm -rf $(echo dist)',
      'rm -rf *',
      'rm -rf .*',
      'rm -rf */dist',
      'rm -rf dist*',
      'rm -rf dist/*',
      'rm -rf d{i,}st',
      // An operand with a directory part may cross a symlinked ancestor that
      // points outside the repository, so only a bare build directory is exempt.
      'rm -rf packages/app/dist',
      'rm -rf linked/dist',
      'rm -rf @scope/pkg/build',
      'rm -rf ./linked/dist',
      'rm -rf a/b/node_modules',
      // A trailing slash makes GNU rm follow a symlinked dist and empty its target.
      'rm -rf dist/',
      'rm -rf ./dist/',
      'rm -rf node_modules/',
      'rm -rf dist -- /tmp/x',
      'rm -rf -- dist',
      'rm -rfi dist',
      'rm -rf dist > out.log',
      'rm -rf dist 2>&1',
      'rm -rf dist & rm -rf src',
      'rm -rf dist; rm -rf src',
      'rm -rf dist\nrm -rf src',
      'rm -rf src; rm -rf dist',
      'rm -rf dist \\\n  src',
      // A directory change anywhere before the rm moves what "dist" means.
      // Remote, container and privilege wrappers do not run rm on this repo.
      'ssh production rm -rf build',
      'docker exec production rm -rf build',
      'kubectl exec pod -- rm -rf dist',
      'env rm -rf dist',
      'nsenter -t 1 -m rm -rf dist',
      'chroot /srv rm -rf dist',
      'cd .. && rm -rf dist',
      'cd / && rm -rf build',
      'cd ~ && rm -rf node_modules',
      'cd /tmp; rm -rf out',
      'pushd .. && rm -rf dist',
      // A sourced or evaluated script may change directory.
      'source /tmp/enter.sh; rm -rf dist',
      '. /tmp/enter.sh; rm -rf dist',
      '. ./enter.sh && rm -rf dist',
      'builtin . x; rm -rf dist',
      'command source x; rm -rf dist',
      'eval "$X"; rm -rf dist',
      'if true; then . x; rm -rf dist; fi',
      'echo hi\n. x\nrm -rf dist',
      '{ . x; }; rm -rf dist',
      'pushd / >/dev/null; rm -rf dist; popd',
      'git -C .. status && rm -rf dist',
      'env -C / rm -rf dist',
      'make -C / clean; rm -rf dist',
      'chroot /x rm -rf dist',
      'bash -c "cd / && rm -rf dist"',
      "sh -c 'cd .. && rm -rf dist'",
      'rm -rf dist && cd / && rm -rf build',
      'true && (cd .. && rm -rf dist)',
    ],
    cwd,
  );
  await expectVerdicts(
    'DENY',
    [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf ~/',
      'rm -rf $HOME',
      'rm -rf /Users',
      'rm -rf /*',
      'rm -rf ~/*',
      'rm -rf --no-preserve-root /',
      'rm -rf --no-preserve-root dist',
      'rm -rf dist; rm -rf /',
      'rm -rf dist && rm -rf ~',
      'rm -rf dist\nrm -rf /',
      'sudo rm -rf dist',
      'shred dist',
    ],
    cwd,
  );
});

test('rm without -r is unchanged', async t => {
  await expectVerdicts(
    'ALLOW',
    ['rm notes.txt', 'rm -f dist/output.js', 'rm -f /tmp/x'],
    fixture(t),
  );
});

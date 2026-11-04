import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// A separator inside a quoted string, or a heredoc body, is not a local command
// boundary: the command may run on a remote host or in a script, so the
// un-prompted rm, git merge, curl -o and migrate exemptions do not apply.
test('commands after a separator inside quotes or a heredoc keep asking', async t => {
  await expectVerdicts(
    'ASK',
    [
      "ssh production 'echo hi; rm -rf build; echo done'",
      'ssh production "echo hi; rm -rf dist"',
      "ssh h 'echo hi\nrm -rf dist'",
      'ssh h "\\"; rm -rf dist; \\""',
      "ssh h 'a; git merge feat/x; b'",
      "ssh h 'a; curl -o x https://x.test/a; b'",
      "ssh h 'a; npm run test:migrations; b'",
      "bash -c 'echo; rm -rf dist'",
      "docker exec c sh -c 'true && rm -rf dist; true'",
      'ssh h <<EOF\nrm -rf dist\nEOF',
      "ssh h <<'EOF'\ngit merge feat/x\nEOF",
      'ssh h <<EOF\nnpm run test:migrations\nEOF',
      'cat <<EOF\nhi\nEOF\nrm -rf dist',
      'echo start\nssh production sh <<EOF\nrm -rf build\nEOF',
      'echo a\necho b\nssh h sh <<EOF\ngit merge feat/x\nEOF',
      "echo a\ncat <<'EOF' | ssh h sh\ncurl -o x https://x.test/a\nEOF",
      'echo a\nssh h sh <<EOF\nnpm run test:migrations\nEOF',
    ],
    fixture(t),
  );
});

test('quotes that hold no command separator do not change the exemptions', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      "echo 'x' && rm -rf dist",
      "rm -rf dist && echo 'a;b'",
      'echo "x y" ; git merge feat/x',
      "git merge -m 'a b' feat/x",
      "bash -c 'rm -rf dist'",
    ],
    fixture(t),
  );
});

test('merge keeps asking for expansions and space-valued global options', async t => {
  await expectVerdicts(
    'ASK',
    [
      'git merge --no-ver{ify,ify} feat/x',
      'git --no-ver{ify,ify} merge feat/x',
      'git merge feat/{a,b}',
      'git merge feat/*',
      'git merge feat/?',
      'git merge feat/[ab]',
      'git --work-tree /tmp merge feat/x',
      'git --work-tree=/tmp merge feat/x',
      'git --git-dir /tmp/x merge feat/x',
      "git --git-dir '/tmp/x y' merge feat/x",
      'git --namespace n merge feat/x',
      'git --super-prefix p merge feat/x',
      'git --config-env a=B merge feat/x',
      'git --attr-source t merge feat/x',
    ],
    fixture(t),
  );
});

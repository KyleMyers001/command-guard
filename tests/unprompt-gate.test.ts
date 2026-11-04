import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {
  curlrcPaths,
  curlrcRiskyIn,
} from '../extensions/command-guard/curlrc.ts';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts, verdict} from './helpers/verdict.ts';

// EL-115 PR6, CR on 33faf92: the gate is default-deny. Verdicts come from the
// shipped policy; nothing is executed.
const ATOMS = [
  'rm -rf dist',
  "gh api graphql -f query='{viewer{login}}'",
  'git merge feat/x',
  'git config user.name',
  'git checkout --detach HEAD~1',
  'curl -sSLo out.json https://x.test/a',
  'npm run test:migrations',
];
const HEADS = [
  'unbuffer',
  'flock /tmp/l',
  'find . -exec',
  'busybox',
  'coproc',
  'docker run img',
  'lxc exec c --',
  'systemd-run',
  'unshare',
  'bwrap --',
  'firejail',
  'npx',
  'npm exec --',
  'pnpm dlx',
  'pnpm exec',
  'bunx',
  'yarn dlx',
  'newgrp',
  'at now',
  'batch',
  'cron',
];
const notAllowed = async (commands: string[], cwd: string) => {
  const loose: string[] = [];
  for (const command of commands)
    if ((await verdict(command, cwd)) === 'ALLOW') loose.push(command);
  assert.deepEqual(loose, []);
};

test('an unlisted head word in a chain is not allowed', async t => {
  const cwd = fixture(t);
  const commands = [];
  for (const atom of ATOMS)
    for (const head of HEADS) {
      commands.push(`${head} ${atom}`, `ls && ${head} ${atom}`);
      commands.push(`${atom} && ${head} sh -c id`);
    }
  for (const atom of ATOMS) commands.push(`npm run x -- ${atom} && id`);
  await notAllowed(commands, cwd);
});

test('compound constructs and stdin sourcing are not allowed', async t => {
  const cwd = fixture(t);
  const commands = [];
  for (const atom of ATOMS)
    commands.push(
      `{ ${atom}; }`,
      `( ${atom} )`,
      `! ${atom}`,
      `if true; then ${atom}; fi`,
      `for i in 1; do ${atom}; done`,
      `while false; do ${atom}; done`,
      `until true; do ${atom}; done`,
      `case x in x) ${atom};; esac`,
      `f() { ${atom}; }; f`,
      `${atom} && . /dev/stdin`,
    );
  await notAllowed(commands, cwd);
});

test('printf -v is not a safe chain member', async t => {
  await notAllowed(
    ['printf -v x %s y && rm -rf dist', 'printf -v PATH %s . && rm -rf dist'],
    fixture(t),
  );
  await expectVerdicts('ALLOW', ['printf ok && rm -rf dist'], fixture(t));
});

test('curlrc fails closed on anything outside the allowlist', t => {
  const home = fixture(t);
  const rc = join(home, '.curlrc');
  const risky = (body: string) => {
    writeFileSync(rc, body);
    return curlrcRiskyIn({HOME: home});
  };
  for (const body of [
    'silent\n# c\n\nshow-error\nlocation\nfail\nretry = 3\n',
    '--retry-delay 2\nconnect-timeout=5\nmax-time: 9\n-sSLf\n',
    'user-agent = "x"\ncompressed\n-A x\n-m 3\n',
  ])
    assert.equal(risky(body), false, body);
  for (const body of [
    'output = x',
    'sil',
    'config = other',
    '-K other',
    'upload-file = a',
    'data = @a',
    'url = https://x',
    '-o x',
    '-sSLo x',
  ])
    assert.equal(risky(body), true, body);
  assert.deepEqual(
    curlrcPaths({HOME: '/h', XDG_CONFIG_HOME: '/x', CURL_HOME: '/c'}).includes(
      '/h/.config/curlrc',
    ),
    true,
  );
  writeFileSync(rc, 'silent\n');
  for (const env of [{CURL_HOME: home}, {XDG_CONFIG_HOME: home}]) {
    writeFileSync(join(home, '.curlrc'), 'output = x\n');
    assert.equal(curlrcRiskyIn({HOME: '/nonexistent', ...env}), true);
  }
  mkdirSync(join(home, 'c', '.config'), {recursive: true});
  writeFileSync(join(home, 'c', '.config', 'curlrc'), 'output = x\n');
  assert.equal(curlrcRiskyIn({HOME: join(home, 'c')}), true);
});

// Absolute bounds, generous for CI; the quadratic forms took seconds.
const SHAPES: [string, string][] = [
  ['heredoc openers', 'a <<EOF\n'.repeat(12000)],
  ['cat heredocs', 'cat <<EOF\n'.repeat(12000)],
  ['echo heredocs', 'echo x <<EOF\n'.repeat(12000)],
  ['quoted heredoc bodies', "cat <<'X'\nrm -rf dist\n".repeat(8000)],
  ['long pipe', 'ls | '.repeat(12000) + 'cat'],
  ['nested quotes', 'echo "a\'b" \'c"d\' '.repeat(6000)],
  ['long chain', 'rm -rf dist && '.repeat(6000) + 'ls'],
  ['repeated curl', 'curl -s '.repeat(10000)],
];
for (const [name, command] of SHAPES)
  test(`analysis stays fast: ${name}`, () => {
    const start = performance.now();
    analyzeCommand(command, '/nonexistent');
    assert.ok(performance.now() - start < 1500, name);
  });

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
  'curl -sSLo out.json https://example.com/a',
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

// CR on 08bfa8d.
test('decoded directory changes keep main verdict (Codex 4466292988)', async t => {
  const commands = [];
  for (const cd of [
    "c''d",
    '\\cd',
    'c\\\nd',
    '"cd"',
    "'cd'",
    'pushd',
    "p''ushd",
    'popd',
  ])
    for (const atom of [
      'rm -rf dist',
      'curl -o out.json https://example.com/a',
    ])
      commands.push(`${cd} /tmp; ${atom}`, `${cd} /tmp && ${atom}`);
  await notAllowed(commands, fixture(t));
});

test('bareness is decided per segment', async t => {
  const commands = [];
  for (const head of ['\\git', "'git'", '"git"', "g''it", 'g\\\nit'])
    for (const tail of [
      'merge feat/x',
      'config user.name',
      'checkout --detach HEAD~1',
    ])
      commands.push(
        `${head} ${tail} ; git status`,
        `git status && ${head} ${tail}`,
      );
  commands.push('\\rm -rf dist; rm -rf build', "r''m -rf dist && rm -rf out");
  await notAllowed(commands, fixture(t));
  await expectVerdicts('ALLOW', ['git merge feat/x ; git status'], fixture(t));
});

test('curl -o names at the root and under out dirs', async t => {
  const cwd = fixture(t);
  await expectVerdicts(
    'ALLOW',
    [
      'curl -sSLo out.json https://example.com/a',
      'curl -o output-v2.json https://example.com/a',
      'curl -o results_1.csv https://example.com/a',
      'curl -o response.txt https://example.com/a',
      'curl -o data.tar.gz https://example.com/a',
      'curl -o artifacts/ci/report.txt https://example.com/a',
    ],
    cwd,
  );
  const ask = [
    'block.txt',
    'notes.json',
    'a.json',
    'outx.json',
    'dist/yarn.lock.json',
    'dist/npm-shrinkwrap.json',
    'dist/policy.json',
    'build/guard.json',
    'out/config.json',
    'tmp/manifest.json',
    'artifacts/app.config.json',
  ].map(path => `curl -o ${path} https://example.com/a`);
  await notAllowed(ask, cwd);
});

test('special-use, internal and wildcard-loopback hosts keep main verdict', async t => {
  const hosts = [
    'intranet',
    'a.localhost',
    'a.local',
    'a.test',
    'a.invalid',
    'a.example',
    'a.internal',
    'a.intranet',
    'a.lan',
    'a.home',
    'a.home.arpa',
    'a.corp',
    'a.private',
    'a.consul',
    'a.svc',
    'a.cluster.local',
    '1.0.0.10.in-addr.arpa',
    'x.ip6.arpa',
    'abc.onion',
    'a.alt',
    'a.vcap.me',
    'a.lacolhost.com',
    'a.localdev.me',
    'a.local.gd',
    'a.nip.io',
    'a.sslip.io',
    'a.xip.io',
    'a.localtest.me',
    'a.lvh.me',
    'a.traefik.me',
  ];
  await notAllowed(
    hosts.map(host => `curl -sSLo out.json https://${host}/a`),
    fixture(t),
  );
});

// Full guard, with the shipped policy: absolute bounds, generous for CI.
const GUARD_SHAPES: [string, string][] = [
  ['curl -s x10000', 'curl -s '.repeat(10000)],
  ['curl -d a x5000', 'curl -d a '.repeat(5000)],
  ['git merge x8000', 'git merge '.repeat(8000)],
  [
    'graphql chain x2000',
    "gh api graphql -f query='{viewer{login}}'; ".repeat(2000),
  ],
  ['64 KB chain', 'rm -rf dist && '.repeat(4400) + 'ls'],
];
for (const [name, command] of GUARD_SHAPES)
  test(`full guard stays bounded: ${name}`, async t => {
    const cwd = fixture(t);
    const start = performance.now();
    await verdict(command, cwd);
    assert.ok(performance.now() - start < 60000, name);
  });

// Sophie's final ruling: a quoted, escaped, continued or expanded command
// word in any segment keeps main's verdict for the whole chain.
const SAFE_HEADS = [
  'ls',
  'cat README.md',
  'head -n 5 README.md',
  'tail -n 5 README.md',
  'wc -l README.md',
  'grep -n x README.md',
  'sort README.md',
  'jq . a.json',
  'echo hi',
  'printf ok',
  'pwd',
  'true',
  'mkdir -p dist',
  'git status',
  'npm run build',
  'cd .',
  'pushd .',
];
const spellings = (command: string): string[] => {
  const [word, ...rest] = command.split(' ');
  const tail = rest.length ? ` ${rest.join(' ')}` : '';
  const cut = Math.max(1, word.length - 1);
  return [
    `'${word}'`,
    `"${word}"`,
    `${word.slice(0, cut)}''${word.slice(cut)}`,
    `\\${word}`,
    `${word.slice(0, cut)}\\\n${word.slice(cut)}`,
    '$X',
    '${X}',
  ].map(spelled => spelled + tail);
};
test('spelled command words in any segment keep main verdict', async t => {
  const commands = [];
  for (const atom of ATOMS)
    for (const safe of SAFE_HEADS)
      for (const spelled of spellings(safe))
        commands.push(`${spelled}; ${atom}`, `${atom} && ${spelled}`);
  await notAllowed(commands, fixture(t));
});

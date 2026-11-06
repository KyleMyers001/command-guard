import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts, verdict} from './helpers/verdict.ts';

const flagged = (command: string): boolean =>
  analyzeCommand(command, '/').canonical.includes('__chain_unsafe__');

// EL-115 PR6: the new exemptions apply only to chains without an output
// redirection, apart from descriptor duplication and /dev/null, /dev/stderr
// or /dev/stdout. Any other output redirection keeps main's verdict.
test('Codex P1 4464443083 and output redirections keep prompting', async t => {
  await expectVerdicts(
    'ASK',
    [
      "r''m -rf dist > command-guard.json",
      "cu''rl -o out.json https://example.com/a > command-guard.json",
      'rm -rf dist > command-guard.json',
      '"rm" -rf dist > command-guard.json',
      'rm -rf dist >> command-guard.json',
      'rm -rf dist &> command-guard.json',
      'rm -rf dist >| command-guard.json',
      'rm -rf dist 1> x',
      'rm -rf dist 2>> log.txt',
      'rm -rf dist >& x',
      'rm -rf dist; echo > x',
      'rm -rf dist > "$F"',
      'rm -rf dist; tee >(cat) < y',
      'curl -o out.json https://example.com/a > x',
      'git merge feat/x > x',
      "gh api graphql -f query='{viewer{login}}' > x",
      'npm run test:migrations > x',
    ],
    fixture(t),
  );
});

// These already prompt through the raw-text rm/curl rules (as on c4503a2),
// so the check is that they do not raise the redirect flag themselves.
test('harmless redirections do not raise the redirect flag', () => {
  for (const command of [
    'rm -rf dist 2>/dev/null',
    'rm -rf dist > /dev/null 2>&1',
    'rm -rf dist >&2',
    'rm -rf dist &>/dev/null',
    'rm -rf dist 2>/dev/stderr',
    'rm -rf dist 1>/dev/stdout',
    'rm -rf dist 2>&-',
    'curl -o out.json https://example.com/a 2>/dev/null',
  ])
    assert.ok(!flagged(command), command);
  for (const command of [
    'rm -rf dist > y',
    'rm -rf dist >&y',
    'rm -rf dist >',
    'rm -rf dist; tee >(cat)',
    'rm -rf dist > "$F"',
  ])
    assert.ok(flagged(command), command);
});

const CLASSES = [
  'rm -rf dist',
  "r''m -rf dist",
  'git merge feat/x',
  'git config user.name',
  'git checkout --detach HEAD~1',
  "gh api graphql -f query='{viewer{login}}'",
  'curl -o out.json https://example.com/a',
  'npm run test:migrations',
];
const FORMS = ['>', '>>', '>|', '&>', '&>>', '1>', '2>', '2>>', '>&'];
const TARGETS = ['x', 'command-guard.json', '"$F"', '~/.bashrc', 'a/b.txt'];

test('generated class x redirect x target sweep keeps prompting', async t => {
  const cwd = fixture(t);
  const allowed: string[] = [];
  for (const c of CLASSES)
    for (const form of FORMS)
      for (const target of TARGETS)
        for (const command of [
          `${c} ${form} ${target}`,
          `${c}; echo hi ${form}${target}`,
        ])
          if ((await verdict(command, cwd)) === 'ALLOW') allowed.push(command);
  assert.deepEqual(allowed, []);
});

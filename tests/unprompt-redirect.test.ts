import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCommand} from '../extensions/command-guard/shell.ts';
import {fixture} from './helpers/fixtures.ts';
import {expectNotExempt, expectVerdicts} from './helpers/verdict.ts';

const flagged = (command: string): boolean =>
  parseCommand(command).writesOutput;

// The exemptions apply only to chains without any redirection, so every one
// of these keeps main's verdict.
test('output redirections keep prompting', async t => {
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

// The scanner tells a redirection that writes a file from one that only
// duplicates or closes a descriptor or writes to a device stream.
test('harmless redirections do not count as writing output', () => {
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
    'rm -rf dist; > x',
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

test('generated class x redirect x target sweep keeps main verdicts', t => {
  const commands: string[] = [];
  for (const c of CLASSES)
    for (const form of [...FORMS, '<', '2>&1 >'])
      for (const target of [...TARGETS, '/dev/null'])
        commands.push(
          `${c} ${form} ${target}`,
          `${c}; echo hi ${form}${target}`,
        );
  expectNotExempt(commands, fixture(t));
});

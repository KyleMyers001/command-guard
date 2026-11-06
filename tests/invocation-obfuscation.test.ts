import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {decide} from './helpers/decide.ts';
import {fixture} from './helpers/fixtures.ts';
import {obfuscationCases, padding} from './helpers/obfuscation.ts';

// EL-115, PR 4, fix: a command with no view (over a size limit) is searched
// for a rule's trigger words as the shell reads them, with quotes, backslashes
// and line continuations gone, also inside a script that is only a string.

const cwd = process.cwd();
const RULE = 'BashCmdRegex(^viewpm -r publish)';
const kinds = [
  ['deny', 'DENY'],
  ['ask', 'ASK'],
] as const;
const pad = padding(1100);

// What the guard decides for each command, in one guard under one policy.
async function verdicts(t: Parameters<typeof fixture>[0], commands: string[]) {
  const policyPath = join(fixture(t), 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      permissions: {
        deny: [
          RULE,
          'BashCmdRegex(^git push --force)',
          'BashCmdRegex(^rm -rf /)',
        ],
        ask: [],
      },
    }),
  );
  const guard = createCommandGuard({policyPath});
  const context = {
    cwd,
    hasUI: true,
    mode: 'tui',
    signal: new AbortController().signal,
    ui: {confirm: async () => false},
  } as unknown as ExtensionContext;
  const out = new Map<string, 'ALLOW' | 'DENY'>();
  for (const command of commands) {
    const event = {
      type: 'tool_call',
      toolCallId: 'verdict',
      toolName: 'bash',
      input: {command},
    } as ToolCallEvent;
    out.set(command, (await guard(event, context)) ? 'DENY' : 'ALLOW');
  }
  return out;
}

// Read from standard input, or from a word computed at run time: no view of
// the command shows the script, so these are missed with a view too.
const unreadable = /<<|\| *(sudo )?(ba)?sh$|\$/u;

test('padded, every obfuscated form is blocked as an unpadded one with a view is', async t => {
  const cases = obfuscationCases();
  assert.ok(cases.length >= 700, String(cases.length));
  const lead = cases.map(c => `echo ${pad}\n${c.command}`);
  const trail = cases.map(c => `${c.command}\necho ${pad}`);
  for (const command of [...lead, ...trail]) {
    assert.equal(analyzeCommand(command, cwd).invocations, undefined);
  }

  const view = await verdicts(
    t,
    cases.map(c => c.command),
  );
  const padded = await verdicts(t, [...lead, ...trail]);
  const missed = (map: Map<string, string>) =>
    [...map].filter(([, verdict]) => verdict === 'ALLOW').map(([c]) => c);

  const viewMisses = missed(view);
  const dynamic = cases.filter(c => c.dynamic).map(c => c.command);
  // With a view the misses are the forms it cannot read.
  for (const command of viewMisses) assert.match(command, unreadable, command);
  // Padded, a command is missed only if its words are computed at run time.
  const paddedMisses = missed(padded);
  assert.equal(paddedMisses.length, 2 * 2, paddedMisses.join('\n'));
  for (const command of paddedMisses) {
    assert.ok(
      dynamic.some(d => command.includes(d)),
      command,
    );
  }
  // And whatever a view misses, the padded command is blocked or missed too.
  for (const c of cases) {
    if (view.get(c.command) === 'DENY') {
      assert.equal(padded.get(`echo ${pad}\n${c.command}`), 'DENY', c.command);
      assert.equal(padded.get(`${c.command}\necho ${pad}`), 'DENY', c.command);
    }
  }
});

test('over the cap, split words inside a script string are found', async t => {
  const forms = {
    sudo: "sudo bash -c \"vi''ewpm -r pub''lish\"",
    backslash: "sudo bash -c 'v\\iewpm -r pub\\lish'",
    ifThen: "if true; then vi''ewpm -r pub''lish; fi",
    brace: '{ vi\'\'ewpm -r pub""lish; }',
    bang: '! vi\\ewpm -r pub\\lish',
    fn: "f() { vi''ewpm -r pub''lish; }; f",
    keywordFn: "function f { vi''ewpm -r pub''lish; }; f",
    while: "while vi''ewpm -r pub''lish; do :; done",
    nohup: "nohup sh -c \"vi''ewpm -r pub''lish\"",
    timeout: 'timeout 5 sh -c \'viewpm -r pub"lish"\'',
    find: "find . -exec sh -c \"vi''ewpm -r pub''lish\" \\;",
    xargs: 'echo x | xargs bash -c \'vi""ewpm -r pub""lish\'',
    herestring: "bash <<<\"vi''ewpm -r pub''lish\"",
    pipe: 'echo \'vi""ewpm -r pub""lish\' | sh',
    continued: "sh -c 'viewpm -r pub\\\nlish'",
    nested: 'sudo sh -c \'sudo bash -c "vi\\ewpm -r pub\\lish"\'',
    codex: `sudo bash -c 'viewpm -r pub"lish"'; echo ${'x'.repeat(9000)}`,
  };
  for (const [kind, expected] of kinds) {
    for (const [name, form] of Object.entries(forms)) {
      for (const command of [`${form}\necho ${pad}`, `echo ${pad}\n${form}`]) {
        assert.equal(analyzeCommand(command, cwd).invocations, undefined, name);
        assert.equal(
          await decide(t, {[kind]: [RULE]}, command),
          expected,
          name,
        );
      }
    }
  }
});

test('over the cap, a split git push inside a script is found', async t => {
  const rule = 'BashCmdRegex(^git push)';
  for (const form of [
    'sh -c "git pu\'\'sh origin HEAD:refs/heads/x"',
    'sudo sh -c \'git pu"sh" origin HEAD:refs/heads/x\'',
    "sh -c 'git pu\\sh origin HEAD:refs/heads/x'",
  ]) {
    const command = `${form}\necho ${pad}`;
    assert.equal(analyzeCommand(command, cwd).invocations, undefined);
    assert.equal(await decide(t, {ask: [rule]}, command), 'ASK', form);
    assert.equal(await decide(t, {deny: [rule]}, command), 'DENY', form);
  }
});

test('over the cap, split words that are not the rule’s are not blocked', async t => {
  for (const form of [
    "sudo bash -c \"vi''ewpm -r bu''ild\"",
    'sh -c \'viewpm -r pub"lic"\'',
    'echo \'vi""ewpm\' publish',
  ]) {
    const command = `${form}\necho ${pad}`;
    assert.equal(await decide(t, {deny: [RULE]}, command), 'ALLOW', form);
  }
});

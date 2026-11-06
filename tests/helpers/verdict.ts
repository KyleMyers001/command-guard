import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../../extensions/command-guard.ts';
import {analyzeCommand} from '../../extensions/command-guard/commands.ts';
import {curlrcRiskyIn} from '../../extensions/command-guard/curlrc.ts';

// Never consult the developer's real curl configuration in fixture verdicts.
const fixtureHome = resolve(tmpdir(), `cg-no-home-${process.pid}`);
const noCurlrc = () => curlrcRiskyIn({HOME: fixtureHome});

export const repository = resolve(import.meta.dirname, '../..');
export type Verdict = 'ALLOW' | 'ASK' | 'DENY';

// Shipped-policy verdicts, with prompts declined and no command execution.
export function verdictWith(curlrcRisky: () => boolean = noCurlrc) {
  const guard = createCommandGuard({
    policyPath: resolve(repository, 'command-guard.json'),
    env: {},
    curlrcRisky,
  });
  return async (command: string, cwd = repository) =>
    judge(guard, command, cwd);
}

export const verdict = verdictWith();

async function judge(
  guard: ReturnType<typeof createCommandGuard>,
  command: string,
  cwd: string,
): Promise<Verdict> {
  let prompts = 0;
  const result = await guard(
    {
      type: 'tool_call',
      toolCallId: 'verdict-helper',
      toolName: 'bash',
      input: {command},
    } as ToolCallEvent,
    {
      cwd,
      hasUI: true,
      mode: 'tui',
      signal: new AbortController().signal,
      ui: {
        confirm: async () => {
          prompts++;
          return false;
        },
      },
    } as unknown as ExtensionContext,
  );
  return result?.block ? (prompts ? 'ASK' : 'DENY') : 'ALLOW';
}

export async function expectAll(commands: string[], expected: Verdict) {
  for (const command of commands) {
    assert.equal(await verdict(command), expected, JSON.stringify(command));
  }
}

export async function expectVerdicts(
  expected: Verdict,
  commands: string[],
  cwd: string,
): Promise<void> {
  const wrong: string[] = [];
  for (const command of commands) {
    const actual = await verdict(command, cwd);
    if (actual !== expected) wrong.push(`${command} -> ${actual}`);
  }
  assert.deepEqual(wrong, [], `expected ${expected}`);
}

// Commands that may not use the exemptions: the policy reads them exactly as
// written, so they keep main's verdict (or a stricter deny).
export function expectNotExempt(commands: string[], cwd = repository): void {
  const exempt = commands.filter(
    command => analyzeCommand(command, cwd, {curlrcRisky: noCurlrc}).exempt,
  );
  assert.deepEqual(exempt, [], 'expected no exemption');
}

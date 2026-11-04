import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {tmpdir} from 'node:os';
import {createCommandGuard} from '../../extensions/command-guard.ts';
import {
  curlrcRiskyIn,
  setCurlrcCheck,
} from '../../extensions/command-guard/curlrc.ts';

// Never the real home directory: a home that does not exist has no curlrc.
const fixtureHome = resolve(tmpdir(), `cg-no-home-${process.pid}`);
setCurlrcCheck(() => curlrcRiskyIn({HOME: fixtureHome}));

export type Verdict = 'ALLOW' | 'ASK' | 'DENY';

const guard = createCommandGuard({
  policyPath: resolve(import.meta.dirname, '../../command-guard.json'),
});

// Verdict of the shipped policy for one bash command. A prompt is answered
// "no", so nothing is ever approved and no command is executed.
export async function verdict(command: string, cwd: string): Promise<Verdict> {
  let prompts = 0;
  const result = await guard(
    {
      type: 'tool_call',
      toolCallId: 'verdict',
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
  if (!result) return 'ALLOW';
  return prompts > 0 ? 'ASK' : 'DENY';
}

// Asserts every command has the expected verdict and reports all misses.
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

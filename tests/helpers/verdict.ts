import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../../extensions/command-guard.ts';

export const repository = resolve(import.meta.dirname, '../..');
// Always the shipped policy, whatever COMMAND_GUARD_POLICY says.
const guard = createCommandGuard({
  policyPath: resolve(repository, 'command-guard.json'),
});

export type Verdict = 'ALLOW' | 'ASK' | 'DENY';

// Prompts are answered "no", so an ASK still blocks and is distinguishable
// from a deny rule by the prompt count. Nothing here ever executes a command.
export async function verdict(command: string): Promise<Verdict> {
  let prompts = 0;
  const result = await guard(
    {
      type: 'tool_call',
      toolCallId: 'register-regression',
      toolName: 'bash',
      input: {command},
    } as ToolCallEvent,
    {
      cwd: repository,
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

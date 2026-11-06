import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../../extensions/command-guard.ts';
import {fixture} from './fixtures.ts';

// What the guard decides for `command` under a policy of the given selectors.
// Prompts are answered "no", so an ASK blocks and a count tells it from a deny.
export async function decide(
  t: TestContext,
  rules: {deny?: string[]; ask?: string[]},
  command: string,
): Promise<'ALLOW' | 'ASK' | 'DENY'> {
  const policyPath = join(fixture(t), 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      permissions: {deny: rules.deny ?? [], ask: rules.ask ?? []},
    }),
  );

  let prompts = 0;
  const result = await createCommandGuard({policyPath})(
    {
      type: 'tool_call',
      toolCallId: 'decide',
      toolName: 'bash',
      input: {command},
    } as ToolCallEvent,
    {
      cwd: process.cwd(),
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

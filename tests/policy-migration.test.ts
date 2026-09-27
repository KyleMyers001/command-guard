import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';

// Captured from the full production combination at the named frozen revision.
// Inputs and verdicts only: no duplicate policy expressions or candidate execution.
const contract = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, 'fixtures/policy-migration-cases.json'),
    'utf8',
  ),
) as {
  baseline: string;
  cases: {
    line: number | null;
    variant: string;
    command: string;
    verdict: 'ALLOW' | 'ASK' | 'DENY';
    prompts: number;
  }[];
};
const repository = resolve(import.meta.dirname, '..');
const guard = createCommandGuard({
  policyPath:
    process.env.COMMAND_GUARD_POLICY ??
    resolve(repository, 'command-guard.json'),
});

for (const line of new Set(contract.cases.map(row => row.line))) {
  test(`combined-policy migration contract: ${line === null ? 'additional cases' : `legacy line ${line}`}`, async () => {
    const cases = contract.cases.filter(row => row.line === line);
    if (line !== null) {
      assert.ok(cases.some(row => row.variant === 'positive'));
      assert.ok(cases.some(row => row.variant === 'neighbor'));
    }
    for (const row of cases) {
      let prompts = 0;
      const result = await guard(
        {
          type: 'tool_call',
          toolCallId: 'migration-contract',
          toolName: 'bash',
          input: {command: row.command},
        } as ToolCallEvent,
        {
          cwd: repository,
          hasUI: true,
          mode: 'tui',
          signal: new AbortController().signal,
          ui: {
            confirm: async () => {
              prompts++;
              return true;
            },
          },
        } as unknown as ExtensionContext,
      );
      const verdict = result?.block ? 'DENY' : prompts ? 'ASK' : 'ALLOW';
      assert.deepEqual(
        {verdict, prompts},
        {verdict: row.verdict, prompts: row.prompts},
        `${row.variant}: ${JSON.stringify(row.command)} (${result?.reason ?? 'no block'})`,
      );
    }
  });
}

test('migration inventory covers every historical active line', () => {
  assert.equal(contract.baseline, '53b5bdc74ec81d20a34020399fc796035911e2b3');
  assert.equal(
    new Set(
      contract.cases.filter(row => row.line !== null).map(row => row.line),
    ).size,
    36,
  );
  assert.equal(contract.cases.length, 879);
});

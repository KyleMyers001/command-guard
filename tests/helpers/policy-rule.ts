import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import {loadPolicy} from '../../extensions/command-guard/policy.ts';
import {fixture} from './fixtures.ts';

export function rule(t: TestContext, selector: unknown) {
  const path = join(fixture(t), 'policy.json');
  writeFileSync(
    path,
    JSON.stringify({version: 1, permissions: {deny: [selector], ask: []}}),
  );
  return loadPolicy(path).deny[0];
}

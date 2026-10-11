import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The returned path is for setup only. Deletion owns exactly this allocation;
// there is intentionally no caller-supplied cleanup path or scavenger.
export function fixture(t: {after: (cleanup: () => void) => void}): string {
  const root = mkdtempSync(join(tmpdir(), 'command-guard-test-'));
  const keep = process.env.COMMAND_GUARD_KEEP_TEST_FIXTURES === '1';
  t.after(() => {
    if (keep) {
      console.error(`Retained test fixture: ${JSON.stringify(root)}`);
      return;
    }
    try {
      rmSync(root, {recursive: true, force: true});
    } catch (error) {
      // Node may report only the test's original error when an after hook also
      // fails. Diagnose cleanup separately, then rethrow so success cannot hide it.
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      console.error(
        `Fixture cleanup failed (${code}): ${JSON.stringify(root)}`,
      );
      throw error;
    }
  });
  return root;
}

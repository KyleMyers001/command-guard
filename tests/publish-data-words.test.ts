import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// Search patterns, printed words, test filters and test-script names are
// data: a runner word there starts no publish. Real publishes, however they
// are wrapped, nested or chained, stay denied. Whole-guard verdicts; nothing
// is executed.

test('searches, printed words and test filters that mention publish run', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'rg -e npm -e publish README.md',
      'git grep -e npm -e publish',
      'rg npm --glob publish README.md',
      'rg -e pnpm -e publish README.md',
      'grep -rn -e yarn -e publish .',
      'echo yarn --version publish',
      'printf "%s\\n" npm --tag latest publish',
      "npm test -- -t 'npm --tag latest publish'",
      "npx vitest -t 'npm --tag latest publish'",
      "npm run test -- -t 'pnpm --filter release publish'",
      'npm test -- -t npm --tag latest publish',
      'npx jest --test-name-pattern npm --tag latest publish',
      'npm run test:publish',
      'npm run check:publish',
      'npm run lint:publish',
      'pnpm run test:publish',
      'yarn run lint-publish',
      'npm install publish',
      'pnpm --filter publish test',
      'npm test -- -t publish',
      'npx vitest publish',
      'rg -e npm -e publish README.md | head -5',
    ],
    fixture(t),
  );
});

test('every real publish stays denied', async t => {
  await expectVerdicts(
    'DENY',
    [
      // Plain.
      'npm publish',
      'npm pub',
      'npm pu',
      'npm --tag latest publish',
      'npm publish --dry-run',
      'pnpm publish',
      'pnpm -r publish',
      'pnpm -F x publish',
      'pnpm --filter x publish',
      'npm -w pkg publish',
      'yarn publish',
      'yarn npm publish',
      // Through package runners.
      'npx changeset publish',
      'npx lerna publish',
      'npx vsce publish',
      'npx --yes jsr publish',
      'npm exec -- npm publish',
      'npx npm publish',
      // Publish scripts.
      'npm run publish',
      'npm run-script publish',
      'npm run release:publish',
      // Wrapped.
      'env npm publish',
      'env -i npm --tag latest publish',
      'command npm --tag latest publish',
      'nice npm publish',
      'time npm publish',
      'xargs npm publish',
      'FOO=1 /usr/bin/npm publish --access public',
      // Scripts and substitutions.
      "sh -c 'npm --tag latest publish'",
      "eval 'npm --tag latest publish'",
      'cat <(npm --tag latest publish)',
      'git status > >(npm --tag latest publish)',
      // Chains.
      'git merge main && npm publish',
      'rm -rf dist && npm run build && npm publish',
      // The policy's text rule.
      'echo npm publish',
      // A data word that a test run or a later runner does not cover.
      'npm test && npm --tag latest publish',
      'npm run deploy -- npm --tag latest publish',
      "npx concurrently 'npm --tag latest publish'",
      "npm test -- x; sh -c 'npm --tag latest publish'",
      // Printed or searched words that the command line then runs.
      'echo npm --tag latest publish | sh',
      'echo npm --tag latest publish | xargs -I{} sh -c {}',
      'bash <(echo npm --tag latest publish)',
      '$(echo npm --tag latest publish)',
      // Options that run a program (`rg --pre`), or any `git grep --o...`
      // spelling that may be `--open-files-in-pager`, keep the full reading.
      'rg --pre npm -e x publish',
      'git grep --or -e npm -e x publish',
    ],
    fixture(t),
  );
});

import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// EL-115 PR6 (Sophie's ruling): package scripts named like `test:migrations`
// or `lint:migrations` only check migration files and no longer prompt. Any
// script that may apply a migration keeps asking. Verdicts come from the
// shipped policy; nothing is executed.
test('test and lint scripts for migrations are allowed', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      'npm run test:migrations',
      'npm run test:migration',
      'npm run test:migrate',
      'npm run test-migrations',
      'npm run lint:migrations',
      'npm run check:migrations',
      'pnpm test:migrations',
      'pnpm run lint:migrations',
      'yarn test:migrations',
      'yarn run check:migration',
      'bun run test:migrations',
      'cd repo && npm run test:migrations',
      'npm ci && npm run lint:migrations',
      'npm run lint:migrations | cat',
      'npm run test:migrations\nnpm test',
    ],
    fixture(t),
  );
});

test('scripts that may apply a migration keep main verdicts', async t => {
  await expectVerdicts(
    'ASK',
    [
      'npm run migrate',
      'npm run migrations',
      'npm run migrate:up',
      'npm run migrate:dev',
      'npm run migrate:test',
      'npm run migration:run',
      'npm run db:migrate',
      'npm run db:migrate:test',
      'npm run db:test:migrations',
      'npm run testing:migrations',
      'npm run test:migrations:up',
      'npm run test:migrations:prod',
      'npm run test:migrate:up',
      'npm run test:migrations-up',
      'npm run test:migrationsx',
      'npm run test:migrations -- --env=prod',
      'npm run test:migrations --prefix other',
      'npm run lint:migrations && npm run migrate',
      'npm run test:migrations; yarn db:migrate',
      'npm run test:migrations\nnpm run migrate',
      'pnpm migrate',
      'pnpm db:migrate',
      'yarn migrate',
      'yarn run db:migrate',
      'bun run migrate',
      'bun migrate',
      // The package manager must start its command: a prefix, wrapper or
      // environment can point the script at a real database.
      'DATABASE_URL=postgres://prod/db npm run test:migrations',
      'NODE_ENV=production yarn test:migrations',
      'env DATABASE_URL=x npm run test:migrations',
      'time npm run test:migrations',
      'xargs npm run test:migrations',
      // Other migration tools are unchanged.
      'npx prisma migrate deploy',
      'prisma migrate dev',
      'prisma db push',
      'alembic upgrade head',
      'rails db:migrate',
      'rake db:migrate',
      'knex migrate:latest',
      'drizzle-kit push',
      'flyway migrate',
      'python manage.py migrate',
    ],
    fixture(t),
  );
  await expectVerdicts(
    'ALLOW',
    ['npm test -- migrations', 'rg migrate src', 'cat docs/migrate.md'],
    fixture(t),
  );
});

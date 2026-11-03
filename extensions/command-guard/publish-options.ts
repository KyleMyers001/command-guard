// Options that take a value, per tool. A value option missing here only makes
// its value look like the subcommand, which denies more. One listed here that
// is really a flag could hide `publish`, so pnpm's `-w` (a flag) is absent.
export type Tool = 'npm' | 'pnpm' | 'yarn' | 'lerna' | 'changeset';

const COMMON_VALUES = [
  '--registry',
  '--tag',
  '--otp',
  '--access',
  '--loglevel',
  '--userconfig',
  '--cache',
  '--scope',
  '--prefix',
  '--cwd',
  '--dir',
];
export const VALUE_OPTIONS: Record<Tool | 'runner' | 'dlx', Set<string>> = {
  npm: new Set([...COMMON_VALUES, '-w', '--workspace', '--include', '--omit']),
  pnpm: new Set([
    ...COMMON_VALUES,
    '-F',
    '--filter',
    '--filter-prod',
    '-C',
    '--publish-branch',
    '--reporter',
  ]),
  yarn: new Set([
    ...COMMON_VALUES,
    '--new-version',
    '--network-timeout',
    '--mutex',
    '--modules-folder',
  ]),
  lerna: new Set([...COMMON_VALUES, '--concurrency', '--ignore', '--dist-tag']),
  changeset: new Set(COMMON_VALUES),
  // `npx` and `npm exec`: `-c`/`--call` carries a shell script.
  runner: new Set([...COMMON_VALUES, '-p', '--package', '-c', '--call']),
  // `pnpm dlx` and `yarn dlx`: `-c` is a flag there.
  dlx: new Set([...COMMON_VALUES, '-p', '--package']),
};

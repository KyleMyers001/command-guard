// What publish.ts needs to find where a command starts, and when npm stops.

// npm prints help or the version and stops at these when one comes first.
export const INFO_FLAGS = new Set(['-h', '-?', '--help', '--version', '-v']);

// Words that come before a command in a segment and are not one:
// `then npm publish`, `! npm publish`, `{ lerna publish; }`.
export const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
]);

// The first wrapper word is the command; the rest cannot be told apart from
// its own options, so any later word may be the command.
export const KEEPS_COMMAND = new Set(['command', 'builtin', 'nohup', 'setsid']);

// Wrappers whose options or arguments cannot be told apart from the command
// they run (`exec -a name cmd`, `flock file cmd`, `find . -exec cmd \;`), so
// any later word may start it.
export const OPTIONED_WRAPPERS = new Set([
  'exec',
  'function',
  'coproc',
  'sudo',
  'doas',
  'nice',
  'ionice',
  'xargs',
  'timeout',
  'stdbuf',
  'caffeinate',
  'flock',
  'unshare',
  'taskset',
  'script',
  'find',
  'chroot',
  'nsenter',
  'setpriv',
  'runuser',
  'su',
  'chrt',
  'numactl',
  'strace',
  'watch',
  'parallel',
  'ssh',
  'systemd-run',
  'fakeroot',
  'eatmydata',
  'unbuffer',
]);

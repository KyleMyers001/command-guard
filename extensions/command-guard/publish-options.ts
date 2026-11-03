// Wrappers that run another command, as publish.ts finds where it starts.

// npm prints help or the version and stops at these when one comes first.
export const INFO_FLAGS = new Set(['-h', '-?', '--help', '--version', '-v']);

// The first wrapper word is the command; the rest cannot be told apart from
// its own options, so any later word may be the command.
export const KEEPS_COMMAND = new Set([
  'command',
  'exec',
  'builtin',
  'nohup',
  'setsid',
]);
export const OPTIONED_WRAPPERS = new Set([
  'sudo',
  'doas',
  'nice',
  'ionice',
  'xargs',
  'timeout',
  'stdbuf',
  'caffeinate',
]);

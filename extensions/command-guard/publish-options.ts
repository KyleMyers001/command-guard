// What publish.ts needs to read a command: when npm stops, and which words
// take a script.

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

// Programs that run a script they are given as a quoted word (`sh -c 'a b'`,
// `su -c`, `ssh host 'a b'`). A quoted word after one of them is read as a
// script; a quoted word anywhere else (`git commit -m "npm publish"`,
// `grep -c "lerna publish" f`, `sudo grep "npm publish" f`) is text. Finding
// the command itself needs no list: every word is scanned.
export const SCRIPT_TAKERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'yash',
  'fish',
  'csh',
  'tcsh',
  'eval',
  'su',
  'runuser',
  'sg',
  'script',
  'flock',
  'ssh',
  'watch',
  'parallel',
]);

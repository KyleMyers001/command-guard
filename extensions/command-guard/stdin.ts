import {basename} from 'node:path';
import type {Word} from './shell.ts';

// Simple commands that read standard input: the right side of a pipe, or a
// command with an input redirection, here-document, here-string or process
// substitution. Filled in by the parser.
const fed = new WeakSet<Word[]>();

export function markStdin(segment: Word[]): void {
  fed.add(segment);
}

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'pdksh',
  'lksh',
  'oksh',
  'fish',
  'ash',
  'yash',
  'rbash',
  'csh',
  'tcsh',
  'busybox',
]);
const STDIN_FILE = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/u;

// Coarse and fail-closed: a stdin-fed command that names a shell anywhere,
// behind any wrapper and its arguments, or that holds an expansion which
// could become one, may run piped input as a script.
export function runsStdinShell(segment: Word[]): boolean {
  const isFed = fed.has(segment) || segment.some(w => STDIN_FILE.test(w.text));
  return isFed && segment.some(w => w.dynamic || SHELLS.has(basename(w.text)));
}

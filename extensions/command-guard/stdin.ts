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

// Coarse and fail-closed: when any command in the chain reads stdin and any
// command names a shell or holds a dynamic word that could become one, piped
// input may run as a script. Chains are not split by group or pipeline, so
// a shell inside `{ ...; }` or `( ... )` that inherits the input counts too.
export function runsStdinShell(segments: Word[][]): boolean {
  const isFed = (segment: Word[]): boolean =>
    fed.has(segment) || segment.some(w => STDIN_FILE.test(w.text));
  const mayBeShell = (segment: Word[]): boolean =>
    segment.some(w => w.dynamic || SHELLS.has(basename(w.text)));
  return segments.some(isFed) && segments.some(mayBeShell);
}

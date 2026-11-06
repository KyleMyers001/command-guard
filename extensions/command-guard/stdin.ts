import type {Word} from './shell.ts';

// Simple commands that read standard input: the right side of a pipe, or a
// command with an input redirection, here-document, here-string or process
// substitution. Filled in by the parser.
const fed = new WeakSet<Word[]>();

export function markStdin(segment: Word[]): void {
  fed.add(segment);
}

export function isFed(segment: Word[]): boolean {
  return fed.has(segment);
}

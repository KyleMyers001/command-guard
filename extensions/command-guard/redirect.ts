import type {Word} from './shell.ts';

// Output redirections seen by the parser, counted across every parse so that
// a caller can tell whether its own parse found one. Parsing is synchronous.
let outputs = 0;

export function outputRedirects(): number {
  return outputs;
}

const HARMLESS_TARGET = /^\/dev\/(?:null|stderr|stdout)$/u;

// Records an output redirection unless it only duplicates or closes a file
// descriptor (`2>&1`, `>&2`, `>&-`) or writes to /dev/null, stderr or stdout.
// A missing target is counted: the guard fails closed.
export function noteOutput(operator: string, target: Word | undefined): void {
  if (target && !target.dynamic) {
    if (operator.endsWith('&') && /^(?:\d+|-)$/u.test(target.text)) return;
    if (HARMLESS_TARGET.test(target.text)) return;
  }
  outputs++;
}

// `>(...)`: a process substitution written to.
export function noteOutputProcess(): void {
  outputs++;
}

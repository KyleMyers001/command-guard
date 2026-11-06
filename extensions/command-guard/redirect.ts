import type {Word} from './shell.ts';

const HARMLESS_TARGET = /^\/dev\/(?:null|stderr|stdout)$/u;

// An output redirection that only duplicates or closes a file descriptor
// (`2>&1`, `>&2`, `>&-`) or writes to /dev/null, stderr or stdout. A missing
// or dynamic target is not harmless: the guard fails closed.
export function isHarmlessOutput(
  operator: string,
  target: Word | undefined,
): boolean {
  if (!target || target.dynamic) return false;
  if (operator.endsWith('&') && /^(?:\d+|-)$/u.test(target.text)) return true;
  return HARMLESS_TARGET.test(target.text);
}

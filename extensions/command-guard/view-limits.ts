import type {Word} from './shell.ts';

// Limits on the invocation view. Past any of them there is no view (see
// `invocationViews`), so the work for one command is bounded.

// A command that may run: `open` when any later word could be where the real
// command starts (after `sudo`, or an `env` option that is not understood).
export interface Run {
  command: Word[];
  open: boolean;
}

// What one command's views have used so far.
export interface Reading {
  runs: Run[];
  words: number;
  chars: number;
}

// The view is built only for a command this size or smaller, and nested no
// deeper than this.
export const MAX_WORDS = 1000;
export const MAX_CHARS = 8192;
export const MAX_DEPTH = 32;
// Tool names in one open command that are each read as a start of their own.
export const MAX_TOOL_STARTS = 32;
// Across every reading of a command: payload words read, and characters of the
// starts of open commands. This bounds the work however the payloads overlap
// (`-exec -exec + ...`).
const MAX_PAYLOAD_WORDS = MAX_WORDS * MAX_DEPTH;
const MAX_START_CHARS = 8_500_000;

export class Skipped extends Error {}

export function tooLarge(segments: Word[][]): boolean {
  let words = 0;
  let chars = 0;
  for (const segment of segments) {
    words += segment.length;
    for (const word of segment) chars += word.text.length;
    if (words > MAX_WORDS || chars > MAX_CHARS) return true;
  }
  return false;
}

export function chargePayload(payload: Word[], read: Reading): void {
  read.words += payload.length;
  if (read.words > MAX_PAYLOAD_WORDS) throw new Skipped();
}

// An open command makes a start of every word, each as long as the rest.
export function chargeStarts(command: Word[], read: Reading): void {
  let tail = 0;
  for (const word of command) tail += word.text.length + 1;
  for (const word of command) {
    read.chars += tail;
    tail -= word.text.length + 1;
  }
  if (read.chars > MAX_START_CHARS) throw new Skipped();
}

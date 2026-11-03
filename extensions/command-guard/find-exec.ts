import type {Word} from './shell.ts';

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// The commands `find` runs for -exec and its relatives, each ended by `;` or
// `+`. Scanning resumes after a payload's terminator: whatever sits inside a
// payload is read when that payload is collected, so nothing is read twice.
// `end` is where the last payload stops.
export function execPayloads(args: Word[]): {payloads: Word[][]; end: number} {
  const payloads: Word[][] = [];
  let end = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i].dynamic || !FIND_EXEC.has(args[i].text)) continue;

    let last = i + 1;
    while (
      last < args.length &&
      (args[last].dynamic || !/^[;+]$/u.test(args[last].text))
    )
      last++;
    payloads.push(args.slice(i + 1, last));
    end = last;
    i = last;
  }
  return {payloads, end};
}

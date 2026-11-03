import {expandScripts} from './scripts.ts';
import type {Word} from './shell.ts';
import {Skipped, chargePayload, type Reading} from './view-limits.ts';

// The command guard expands a literal `sh -c` or `eval` script only where a
// segment begins with it. The view reads further: one after a shell keyword
// (`if`, `then`, `{`, `!` ...), where the script is still the command. Its own
// commands are returned, and a script that cannot be read means no view. This
// changes no verdict of the guard itself, which never reads these scripts.
export function scriptsOf(command: Word[], read: Reading): Word[][] {
  const {segments, decisions} = expandScripts([command]);
  if (decisions.length > 0) throw new Skipped();

  // The first segment is the command itself.
  const inner = segments.slice(1);
  chargePayload(inner.flat(), read);
  return inner;
}

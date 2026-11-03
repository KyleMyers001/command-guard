import {expandScripts, runsScripts} from './scripts.ts';
import type {Word} from './shell.ts';
import type {CommandStart} from './view-command.ts';
import {Skipped, chargePayload, type Reading} from './view-limits.ts';

// The command guard expands a literal `sh -c` or `eval` script only where a
// segment begins with it. The view reads further, wherever the script is still
// the command that runs:
//  - after a shell keyword (`if`, `then`, `{`, `!` ...) or a function header;
//  - after a prefix such as `sudo`, `command`, `nohup`, `timeout` or `xargs`,
//    or an `env` option that is not understood, where any later word may be
//    the shell (`open`).
// The commands of each script are returned. A script that cannot be read means
// no view. This changes no verdict of the guard itself, which never reads them.
export function scriptsOf(
  {command, bare, stripped}: CommandStart,
  open: boolean,
  read: Reading,
): Word[][] {
  const found: Word[][] = [];
  const expand = (words: Word[]) => {
    chargePayload(words, read);
    const {segments, decisions} = expandScripts([words]);
    if (decisions.length > 0) throw new Skipped();

    // The first segment is the command itself.
    chargePayload(segments.slice(1).flat(), read);
    found.push(...segments.slice(1));
  };

  if (stripped) expand(bare);
  if (open) {
    command.forEach((word, i) => {
      if (runsScripts(word)) expand(command.slice(i));
    });
  }
  return found;
}

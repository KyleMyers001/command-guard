import type {Word} from './shell.ts';

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// Tests and actions that take the next word as their operand, even when it
// reads like `-exec`: in `find -name -exec -o -exec cmd ;` only the second is
// an action. `-fprintf` takes two operands.
const ONE_OPERAND =
  /^-(?:i?name|i?path|i?wholename|i?regex|i?lname|[acm]?newer|newer[aBcmt][aBcmt]|type|xtype|perm|user|group|uid|gid|size|[acm](?:time|min)|links|inum|samefile|fstype|used|context|printf|fprint0?|fls|regextype|maxdepth|mindepth|files0-from)$/u;

function isWord(word: Word | undefined, text: string): boolean {
  return word !== undefined && !word.dynamic && word.text === text;
}

// The commands `find` runs for -exec and its relatives, from the words after
// `find`. A payload ends at `;`, or at `+` right after `{}`; with neither it
// runs to the end. A `+` anywhere else ends the payload only as an extra
// reading, which can only add commands. Scanning resumes after the terminator:
// what sits inside a payload is read when that payload is collected, so no word
// is read twice and the work is linear in the words.
export function execPayloads(args: Word[]): Word[][] {
  const payloads: Word[][] = [];

  for (let i = 0; i < args.length; i++) {
    const {text, dynamic} = args[i];
    if (dynamic) continue;
    if (ONE_OPERAND.test(text)) i += text === '-fprintf' ? 2 : 1;
    if (!FIND_EXEC.has(text)) continue;

    let last = i + 1;
    while (last < args.length && !isWord(args[last], ';')) {
      if (isWord(args[last], '+')) {
        if (args[last - 1].text === '{}') break;
        payloads.push(args.slice(i + 1, last));
      }
      last++;
    }
    payloads.push(args.slice(i + 1, last));
    i = last;
  }
  return payloads;
}

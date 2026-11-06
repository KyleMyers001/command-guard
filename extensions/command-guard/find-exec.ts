import type {Word} from './shell.ts';

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// Tests and actions that take the next word as their operand, even when it
// reads like `-exec`: in `find -name -exec -o -exec cmd ;` only the second is
// an action. `-fprintf` takes two operands. `-D` takes the debug options.
const ONE_OPERAND =
  /^-(?:i?name|i?path|i?wholename|i?regex|i?lname|[acm]?newer|newer[aBcmt][aBcmt]|type|xtype|perm|user|group|uid|gid|size|[acm](?:time|min)|links|inum|samefile|fstype|used|context|printf|fprint0?|fprintf|fls|regextype|maxdepth|mindepth|files0-from|D)$/u;

function isWord(word: Word | undefined, text: string): boolean {
  return word !== undefined && !word.dynamic && word.text === text;
}

// The commands `find` runs for -exec and its relatives, from the words after
// `find`. A payload ends at `;`, or at `+` right after `{}`; with neither it
// runs to the end. The first `+` elsewhere also ends one extra, shorter reading
// (which can only add commands). Scanning resumes after the terminator, so the
// payloads of one scan are the words once, plus at most one extra per -exec.
export function execPayloads(args: Word[]): Word[][] {
  const payloads: Word[][] = [];

  for (let i = 0; i < args.length; i++) {
    const {text, dynamic} = args[i];
    if (dynamic) continue;
    if (ONE_OPERAND.test(text)) i += text === '-fprintf' ? 2 : 1;
    if (!FIND_EXEC.has(text)) continue;

    let last = i + 1;
    let extra = false;
    while (last < args.length && !isWord(args[last], ';')) {
      if (isWord(args[last], '+')) {
        if (args[last - 1].text === '{}') break;
        if (!extra) payloads.push(args.slice(i + 1, last));
        extra = true;
      }
      last++;
    }
    payloads.push(args.slice(i + 1, last));
    i = last;
  }
  return payloads;
}

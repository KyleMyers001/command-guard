import {unwrap} from './scripts.ts';
import type {Word} from './shell.ts';

// Where a simple command really starts: past the words that stand before it
// without being part of it.

// Words that stand where a command may start but are not part of it.
const KEYWORDS = new Set([
  '!',
  '{',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
]);

// `{fd}` of `{fd}>file`: the shell names a new descriptor with it. The parser
// drops the redirection's target and operator but keeps this word, wherever
// it was written.
const NAMED_FD = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

// `segment` without the shell keywords that introduce its command.
function withoutKeywords(segment: Word[]): Word[] {
  // A lone `{` is flagged dynamic (brace expansion) but is only the keyword.
  const keyword = ({text, dynamic}: Word) =>
    KEYWORDS.has(text) && (!dynamic || text === '{');

  // `function name {` only names the body that follows.
  const definition = (i: number) =>
    segment[i].text === 'function' &&
    !segment[i].dynamic &&
    segment[i + 2]?.text === '{';

  let i = 0;
  while (i < segment.length) {
    if (keyword(segment[i])) i++;
    else if (definition(i)) i += 3;
    else break;
  }
  return segment.slice(i);
}

export interface CommandStart {
  // The command, as `unwrap` leaves it.
  command: Word[];
  resolved: boolean;
  // The words from where keywords and named descriptors are gone.
  bare: Word[];
  // True if any were: the guard's own script expansion did not see the command.
  stripped: boolean;
}

export function commandOf(words: Word[]): CommandStart {
  const kept = words.filter(word => !NAMED_FD.test(word.text));
  const bare = withoutKeywords(kept);
  const {command, resolved} = unwrap(bare);
  return {command, resolved, bare, stripped: bare.length < words.length};
}

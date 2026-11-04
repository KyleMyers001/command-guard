import {basename} from 'node:path';
import {carriesCommand} from './carrier.ts';
import {isClassAtom, normalize, SHELLS} from './chain.ts';
import {curlWrites} from './curl.ts';
import {curlrcRisky} from './curlrc.ts';
import {filters, isSafe} from './safe.ts';
import type {Word} from './shell.ts';
import {isFed} from './stdin.ts';

// EL-115 PR6 chain gate (Sophie's rulings, default deny). When any class
// word appears, the exemptions may loosen the command only if it is
// provably safe: every simple command is a bare, literal class atom or on
// the safe list, nothing expands, substitutes, groups, runs a nested shell,
// pipes into anything but a fixed text filter, or writes through a
// redirection. Otherwise the parser adds `__chain_unsafe__` and an ask rule
// keeps main's verdict.

// The shapes the seven exemptions loosen, unanchored (CR F1): wherever one
// appears in the raw or canonical text, the command must prove itself safe.
// Each shape is tested only at a segment start, with lookaheads that scan
// that segment once, so the cost stays linear in the text.
const SEGMENT = String.raw`(?:^|[\n;&|])`;
const BODY = String.raw`[^\n;&|]*`;
const has = (word: string) =>
  String.raw`(?=${BODY}?(?<![\w.-])${word}(?![\w-]))`;
const CLASS_SHAPE = new RegExp(
  [
    `${has('rm')}(?=${BODY}\\s(?:-[a-zA-Z]*[rR]|--recursive))`,
    `${has('git')}(?=${BODY}\\s(?:merge|checkout)(?![\\w-])|${BODY}\\sconfig\\s+\\S)`,
    String.raw`(?=${BODY}?(?:graphql|--detach(?![\w-])|(?:test|lint|check)[:-]migrat))`,
    `${has('curl')}(?=${BODY}\\s(?:-[a-zA-Z]*[oO]|--output|--remote-name)(?![\\w-])(?![=\\s]+/dev/null(?![\\w/.-])))`,
  ]
    .map(shape => SEGMENT + shape)
    .join('|'),
  'mu',
);
export const mentionsClass = (...texts: string[]): boolean =>
  texts.some(text => CLASS_SHAPE.test(text));

// Expansion, substitution, heredocs and here-strings outside single quotes;
// device and proc paths; input redirected from outside the repository.
const RISKY_TEXT =
  /[$`]|[<>]\(|<<|(?<!>\s*)\/dev\/(?!null(?![\w/.-]))|>\s*\/dev\/(?!(?:null|stdout|stderr)(?![\w/.-]))|\/proc\/|<\s*(?:[/~]|\.\.)/u;
// Groups, subshells, negation and brace expansion, outside quotes.
const COMPOUND = /[(){}!]/u;
// Steps that change what a relative path names (kept from 10df0fe's rules).
const MOVES_DIR =
  /(?<![\w./-])(?:cd|pushd|popd|chdir|chroot|source|eval)(?![\w.-])|(?:^|[;&|(\n{]|then|do|else)\s*(?:(?:builtin|command)\s+)?\.(?=\s)|\s-C(?![\w-])|--chdir/u;

// One pass over the text: `plain` has every quoted string and escaped
// character replaced by `_`; `live` keeps double-quoted text, where `$` and
// backticks still expand. Undefined when a quote is left open.
function scan(text: string): {plain: string; live: string} | undefined {
  let plain = '';
  let live = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      plain += '_';
      live += '_';
      i++;
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== char)
        j += char === '"' && text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return undefined;
      plain += '_';
      live += char === '"' ? text.slice(i, j + 1) : '_';
      i = j;
    } else {
      plain += char;
      live += char;
    }
  }
  return {plain, live};
}

const texts = (segment: Word[]): string[] => segment.map(word => word.text);

export function chainUnsafe(
  command: string,
  parsed: Word[][],
  expanded: Word[][],
  wroteOutput: boolean,
): boolean {
  const text = scan(command);
  if (
    wroteOutput ||
    text === undefined ||
    RISKY_TEXT.test(text.live) ||
    COMPOUND.test(text.plain)
  )
    return true;
  const {plain} = text;
  // Ruling 1: a nested shell or eval anywhere keeps main's verdict.
  if (expanded.length !== parsed.length) return true;
  const words = parsed.map(texts);
  if (
    words.some(
      list =>
        normalize(list)[0] === '.' ||
        list.some(word => SHELLS.has(basename(word))) ||
        carriesCommand(list),
    )
  )
    return true;
  const atoms = words.filter(isClassAtom);
  if (
    atoms.some(list => list[0] === 'rm' || list[0] === 'curl') &&
    MOVES_DIR.test(command)
  )
    return true;
  if (
    words.some(
      list =>
        normalize(list)[0] === 'curl' &&
        curlWrites(list.slice(1)) &&
        (!isClassAtom(list) || curlrcRisky()),
    )
  )
    return true;
  // Bare means as written: `\rm` or `r''m` decode to `rm` but are not bare.
  const heads = new Map<string, number>();
  for (const list of atoms) heads.set(list[0], (heads.get(list[0]) ?? 0) + 1);
  for (const [head, count] of heads) {
    const bare = new RegExp(`(?:^|[;&|\\n])[ \\t]*${head}(?=[ \\t]|$)`, 'gu');
    if ((plain.match(bare)?.length ?? 0) < count) return true;
  }
  for (let i = 0; i < parsed.length; i++) {
    const segment = parsed[i];
    if (segment.length === 0) continue;
    if (segment[0].dynamic) return true;
    if (parsed.length > 1 && isFed(segment) && !filters(words[i])) return true;
  }
  // Default deny: every command, alone or chained, is an atom or safe-listed.
  return !words.every(
    list => list.length === 0 || isClassAtom(list) || isSafe(list),
  );
}

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
const DIR_HEADS = new Set(['cd', 'pushd', 'popd', 'chdir', 'chroot', '.']);
const MOVES_DIR =
  /(?<![\w./-])(?:cd|pushd|popd|chdir|chroot|source|eval)(?![\w.-])|(?:^|[;&|(\n{]|then|do|else)\s*(?:(?:builtin|command)\s+)?\.(?=\s)|\s-C(?![\w-])|--chdir/u;

// One pass over the text: `plain` has every quoted string and escaped
// character replaced by MARK; `live` keeps double-quoted text, where `$` and
// backticks still expand. Undefined when a quote is left open.
// Stands in for a quoted string or escaped character in `plain`.
const MARK = '\u0001';
// Stands in for a backslash escape outside quotes.
const ESCAPE = '\u0002';
function scan(text: string): {plain: string; live: string} | undefined {
  let plain = '';
  let live = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      plain += ESCAPE;
      live += '_';
      i++;
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== char)
        j += char === '"' && text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return undefined;
      plain += MARK;
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
  // A directory change is found in the raw text and in the decoded words,
  // so `c''d`, `\cd` and `c\<newline>d` count too (Codex 4466292988).
  if (
    atoms.some(list => list[0] === 'rm' || list[0] === 'curl') &&
    (MOVES_DIR.test(command) ||
      words.some(
        list =>
          DIR_HEADS.has(list[0]) ||
          DIR_HEADS.has(normalize(list)[0]) ||
          list.some(word => /^(?:-C|--chdir(?:=.*)?)$/u.test(word)),
      ))
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
  // Bare means as written, decided per segment: the segment that holds an
  // atom must start with the literal head (`\\git`, `'git'`, `g''it` keep
  // main's verdict). Segments that cannot be matched up fail closed.
  const spelled = plain
    .split(/&&|\|\||(?<![<>])&(?!>)|(?<![>&])\|(?!&)|\|&|[;\n]/u)
    // Only ASCII spaces: trim() would drop CR, TAB, VT, FF, NBSP, FEFF and
    // U+2028 before the command-word check (CR R1, Sophie's ruling).
    .map(part => part.replace(/^ +| +$/gu, ''))
    .filter(part => part !== '');
  const listed = words.filter(list => list.length > 0);
  if (spelled.length !== listed.length) return true;
  for (let i = 0; i < listed.length; i++) {
    // Sophie's final ruling: any segment whose command word is quoted,
    // escaped, continued or expanded keeps main's verdict for the chain.
    // A redirection before the command word, or a command word holding a
    // control or non-ASCII character (CR, TAB, ...), also keeps it.
    const head = /^[^ ]*/u.exec(spelled[i])?.[0] ?? '';
    if (/[$`]|[^\x21-\x7e]|^\d*[<>]|^&>/u.test(head)) return true;
    if (/[^\x21-\x7e]/u.test(listed[i][0])) return true;
    // echo/printf args are checked decoded in safe.ts; an unquoted `\n` decodes
    // to `n`, so a raw backslash escape in the segment also fails closed.
    if (/^(?:echo|printf)$/u.test(listed[i][0]) && spelled[i].includes(ESCAPE))
      return true;
    if (
      isClassAtom(listed[i]) &&
      !new RegExp(`^${listed[i][0]}(?:[ \\t]|$)`, 'u').test(spelled[i])
    )
      return true;
  }

  for (let i = 0; i < parsed.length; i++) {
    const segment = parsed[i];
    if (segment.length === 0) continue;
    if (segment[0].dynamic) return true;
    if (parsed.length > 1 && isFed(segment) && !filters(words[i])) return true;
  }
  // Default deny: every command, alone or chained, is an atom or safe-listed.
  return !words.every(
    list =>
      list.length === 0 ||
      isClassAtom(list) ||
      isSafe(list, listed.length === 1),
  );
}

import {basename} from 'node:path';
import {curlWrites} from './curl.ts';
import {exemptClass, type ExemptClass} from './exemptions.ts';
import type {CommandTexts} from './match.ts';
import {filters, isSafe} from './safe.ts';
import type {Parsed, Word} from './shell.ts';
import {spell} from './spelling.ts';

// Decides whether a command may use the exemptions in exemptions.ts. It may
// only when it is a chain of simple commands, each an exempt command or on
// the safe list (safe.ts), with nothing that expands, substitutes, groups,
// runs a nested shell, changes directory before an `rm` or `curl`, pipes into
// anything but a fixed text filter, or writes through a redirection. Then the
// ask rules read the command with each exempt command's name blanked out, so
// a rule keyed on `rm`, `git`, `gh`, `curl` or a package manager no longer
// sees it, while every other rule still reads the rest. Deny rules always
// read the whole command. Any other command keeps the policy as written.

const SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'source',
]);
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'nice',
  'nohup',
  'timeout',
  'sudo',
  'doas',
  'time',
  'builtin',
  'xargs',
  'stdbuf',
  'ionice',
  'setsid',
  'caffeinate',
  'chronic',
]);
// Commands that run another command line out of sight.
const CARRIERS = /^(?:ssh|su|nsenter|chroot)$/u;

// The program a segment runs once assignments, wrappers and their options
// are skipped, without its path.
function program(words: string[]): string {
  const head = words.find(
    word =>
      !/^[A-Za-z_]\w*=/u.test(word) &&
      !word.startsWith('-') &&
      !/^\d+(?:\.\d+)?[smhd]?$/u.test(word) &&
      !WRAPPERS.has(basename(word)),
  );
  return basename((head ?? '').replace(/^\\/u, ''));
}

function runsHidden(words: string[]): boolean {
  const head = program(words);
  return (
    head === '.' ||
    SHELLS.has(head) ||
    CARRIERS.test(head) ||
    words.some(word => SHELLS.has(basename(word))) ||
    (/^(?:docker|podman|kubectl)$/u.test(head) && words.includes('exec'))
  );
}

// Expansion, substitution, heredocs and here-strings outside single quotes;
// device and proc paths; input redirected from outside the repository.
const RISKY_TEXT =
  /[$`]|[<>]\(|<<|(?<!>\s*)\/dev\/(?!null(?![\w/.-]))|>\s*\/dev\/(?!(?:null|stdout|stderr)(?![\w/.-]))|\/proc\/|<\s*(?:[/~]|\.\.)/u;
// Groups, subshells, negation, brace expansion and comments, outside quotes.
const COMPOUND = /[(){}!#]/u;
// Anything but printable ASCII, space and newline. The scanner reads a
// carriage return as a word break, which the shell does not.
const UNUSUAL = /[^\x20-\x7e\n]/u;
// Steps that change what a relative path names.
const DIR_HEADS = new Set(['cd', 'pushd', 'popd', 'chdir', 'chroot', '.']);
const MOVES_DIR =
  /(?<![\w./-])(?:cd|pushd|popd|chdir|chroot|source|eval)(?![\w.-])|(?:^|[;&|(\n{]|then|do|else)\s*(?:(?:builtin|command)\s+)?\.(?=\s)|\s-C(?![\w-])|--chdir/u;

// The command with every quoted string replaced by `_` (`unquoted`) and with
// double-quoted text kept, where `$` and backticks still expand (`live`).
// Undefined when a quote is left open.
function scan(text: string): {unquoted: string; live: string} | undefined {
  let unquoted = '';
  let live = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      unquoted += '_';
      live += '_';
      i++;
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== char)
        j += char === '"' && text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return undefined;
      unquoted += '_';
      live += char === '"' ? text.slice(i, j + 1) : '_';
      i = j;
    } else {
      unquoted += char;
      live += char;
    }
  }
  return {unquoted, live};
}

// `echo` decodes nothing without options, but the shell still expands an
// unquoted `~`, glob or other special character before echo sees it.
const ECHO_WORD = /^(?:[\w.,:/=+-]|'[^']*'|"[^"$`\\]*")+$/u;

const end = (word: Word): number => (word.start ?? 0) + (word.raw ?? '').length;

// What a segment spans in the command, from its first word to its last.
const span = (command: string, segment: Word[]): string =>
  command.slice(segment[0].start, end(segment[segment.length - 1]));

// The texts the ask rules read when the command may use the exemptions,
// otherwise undefined. `curlrcRisky` reports whether a curl config file could
// redirect a download.
export function exemptTexts(
  command: string,
  parsed: Parsed,
  expanded: Word[][],
  curlrcRisky: () => boolean,
): CommandTexts | undefined {
  const {segments} = parsed;
  const text = scan(command);
  if (
    parsed.writesOutput ||
    text === undefined ||
    UNUSUAL.test(command) ||
    RISKY_TEXT.test(text.live) ||
    COMPOUND.test(text.unquoted) ||
    // A nested shell or eval added commands of its own.
    expanded.length !== segments.length ||
    segments.some(segment => segment.some(word => word.dynamic))
  )
    return undefined;

  const words = segments.map(segment => segment.map(word => word.text));
  const classes: (ExemptClass | undefined)[] = segments.map(exemptClass);
  if (!classes.some(Boolean) || words.some(runsHidden)) return undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const head = segment[0];
    // The program is named as written: no quote, escape or continuation.
    if (head.raw !== head.text || head.text.startsWith('-')) return undefined;
    // No command has a redirection, and only a fixed filter reads a pipe.
    if (parsed.redirected.has(segment)) return undefined;
    if (parsed.fed.has(segment) && !filters(words[i])) return undefined;
    if (classes[i]) {
      // No backslash anywhere in an exempt command: a continuation between
      // words is not part of either word.
      if (span(command, segment).includes('\\')) return undefined;
    } else if (
      !isSafe(words[i]) ||
      (head.text === 'echo' &&
        !segment.slice(1).every(word => ECHO_WORD.test(word.raw ?? '')))
    )
      return undefined;
  }

  // A relative path names something else after a directory change. The raw
  // text is checked too, so `c''d` and `\cd` count.
  const removesOrWrites = classes.some(
    found => found === 'rm' || found === 'curl',
  );
  if (
    removesOrWrites &&
    (MOVES_DIR.test(command) ||
      words.some(
        list =>
          DIR_HEADS.has(list[0]) ||
          list.some(word => /^(?:-C|--chdir(?:=.*)?)$/u.test(word)),
      ))
  )
    return undefined;

  // A download must end the command and no curl config may redirect it; any
  // other curl that writes a file keeps the ask.
  for (let i = 0; i < segments.length; i++) {
    if (program(words[i]) !== 'curl' || !curlWrites(words[i].slice(1)))
      continue;
    const last = segments[i][segments[i].length - 1];
    if (
      classes[i] !== 'curl' ||
      command.slice(end(last)).trim() !== '' ||
      curlrcRisky()
    )
      return undefined;
  }
  if (classes.includes('graphql') && /mutation/iu.test(command))
    return undefined;

  // Blank each exempt command's name, keeping every other character where
  // it was, and drop it from that command's canonical line.
  let raw = command;
  const lines = segments.map((segment, i) => {
    const kept = classes[i] ? segment.slice(1) : segment;
    if (classes[i]) {
      const {start = 0, text: name} = segment[0];
      raw =
        raw.slice(0, start) +
        ' '.repeat(name.length) +
        raw.slice(start + name.length);
    }
    return kept.map(spell).join(' ');
  });
  return {raw, canonical: lines.join('\n'), lines};
}

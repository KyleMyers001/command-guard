// Trigger words of a `BashCmdRegex` rule: the literal words every match of its
// regex must contain. When a command has no view (it is too large, or runs a
// script that cannot be read), the rule gives its verdict only if the command's
// text holds these words; otherwise it is decided as a `BashRegex` rule would
// be. With no words to derive, the rule matches any command with no view.
//
// The regex is read as a small grammar. Each part yields `Terms`: a list of
// alternatives, each a list of words that must all appear. A sequence needs all
// its parts, so it keeps as many as it can name; an alternation needs one of
// its branches, so one branch with nothing required means nothing is. Dropping
// a requirement only makes the words easier to find, never the rule looser.

type Terms = string[][] | undefined;

const MAX_TERMS = 32;
// The characters `spell` leaves unquoted; a quoted word may hold others.
const WORD_BREAK = /[^A-Za-z0-9_@%+=:,./~^-]+/u;

function both(left: Terms, right: Terms): Terms {
  if (!left) return right;
  if (!right || left.length * right.length > MAX_TERMS) return left;
  return left.flatMap(a => right.map(b => [...a, ...b]));
}

class Reader {
  at = 0;
  private min = 0;
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  // Alternatives up to the closing `)` (not consumed) or the end.
  alternation(): Terms {
    let all: string[][] = [];
    let known = true;
    for (;;) {
      const branch = this.sequence();
      if (branch) all = all.concat(branch);
      else known = false;
      if (this.source[this.at] !== '|') break;
      this.at++;
    }
    return known && all.length <= MAX_TERMS ? all : undefined;
  }

  private sequence(): Terms {
    let terms: Terms;
    let run = '';
    const flush = () => {
      if (run) terms = both(terms, [[run]]);
      run = '';
    };

    while (this.at < this.source.length) {
      const char = this.source[this.at];
      if (char === '|' || char === ')') break;
      this.at++;

      let atom: Terms;
      let literal = '';
      if (char === '\\') {
        const next = this.source[this.at++] ?? '';
        if (next === 'b' || next === 'B') continue;
        if (/[A-Za-z0-9]/u.test(next)) {
          this.skipEscape(next);
          atom = undefined;
        } else {
          literal = next;
        }
      } else if (char === '[') {
        this.skipClass();
      } else if (char === '(') {
        atom = this.group();
      } else if (char === '^' || char === '$') {
        continue;
      } else if (char === '.') {
        atom = undefined;
      } else {
        literal = char;
      }

      // Anything repeated or optional can stand for no text at all.
      if (this.quantifier()) {
        flush();
        if (atom && this.min > 0) terms = both(terms, atom);
      } else if (literal) {
        run += literal;
      } else {
        flush();
        terms = both(terms, atom);
      }
    }
    flush();
    return terms;
  }

  // Consumes a quantifier; true if there was one.
  private quantifier(): boolean {
    const rest = this.source.slice(this.at);
    const found = /^(?:[*+?]|\{(\d+)(?:,\d*)?\})\??/u.exec(rest);
    if (!found) return false;
    this.at += found[0].length;
    this.min = found[0][0] === '+' ? 1 : Number(found[1] ?? 0);
    return true;
  }

  // The rest of `\x41`, `\u0041`, `\u{41}`, `\p{Lu}`, `\k<name>`, `\cJ`, `\12`.
  private skipEscape(kind: string): void {
    const patterns: Record<string, RegExp> = {
      x: /^[0-9a-fA-F]{2}/u,
      u: /^(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/u,
      p: /^\{[^}]*\}/u,
      P: /^\{[^}]*\}/u,
      k: /^<[^>]*>/u,
      c: /^[A-Za-z]/u,
    };
    const pattern = /\d/u.test(kind) ? /^\d*/u : patterns[kind];
    this.at += pattern?.exec(this.source.slice(this.at))?.[0].length ?? 0;
  }

  private skipClass(): void {
    while (this.at < this.source.length) {
      const char = this.source[this.at++];
      if (char === '\\') this.at++;
      else if (char === ']') return;
    }
  }

  private group(): Terms {
    const head = /^\?(?:(<?[=!])|<[^>]*>|[a-z-]*:)?/u.exec(
      this.source.slice(this.at),
    );
    const lookaround = Boolean(head?.[1]);
    this.at += head?.[0].length ?? 0;
    const inner = this.alternation();
    if (this.source[this.at++] !== ')') throw new Error('unclosed group');
    return lookaround ? undefined : inner;
  }
}

// The words of one alternative, as written: they are matched with the case
// folding of the rule's own regex.
function wordsOf(runs: string[]): string[] | undefined {
  const words = runs
    .flatMap(run => run.split(WORD_BREAK))
    .filter(word => word.length >= 2);
  return words.length > 0 ? [...new Set(words)] : undefined;
}

// The alternatives a command must satisfy, one of them in full, to trigger the
// rule; undefined if there are none to derive.
export function regexTriggers(source: string): string[][] | undefined {
  try {
    const reader = new Reader(source);
    const terms = reader.alternation();
    if (!terms || reader.at < source.length) return undefined;

    const alternatives = terms.map(wordsOf);
    return alternatives.every(Boolean)
      ? (alternatives as string[][])
      : undefined;
  } catch {
    return undefined;
  }
}

// `regexTriggers` as matchers that fold case as the rule's regex does: with
// `iu`, `ſ` is an `s`. A `(?i:...)` that may not cover the whole expression
// makes every word case-insensitive, which only widens it.
export function triggerMatchers(source: string): RegExp[][] | undefined {
  const fold = /\(\?[a-z]*i[a-z-]*:/u.test(source) ? 'iu' : 'u';
  return regexTriggers(source)?.map(words =>
    words.map(word => new RegExp(escaped(word), fold)),
  );
}

function escaped(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// The command's text, then as the shell reads it once quotes and backslashes
// are gone: `pn''pm` is `pnpm`, also inside a script that is only a string.
export function textVariants(commands: string[]): string[] {
  return commands.flatMap(command => [
    command,
    command
      .replace(/\\\r?\n/gu, '')
      .replace(/\$(?=['"])/gu, '')
      .replace(/['"\\`]/gu, ''),
  ]);
}

// True if the text holds every word of at least one alternative.
export function hasTriggers(text: string, triggers: RegExp[][]): boolean {
  return triggers.some(words => words.every(word => word.test(text)));
}

import type {Word} from './shell.ts';

// The canonical spelling of one word: bare when safe, else single-quoted.
export function spell(word: Word | string): string {
  const text = typeof word === 'string' ? word : word.text;
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// A brace pair with no comma or range, like gh's `{owner}`, stays literal.
const expands = (word: Word | string) =>
  typeof word !== 'string' &&
  word.dynamic &&
  (word.expands === true || /\{[^}]*(?:,|\.\.)[^}]*\}/u.test(word.text));

// Quoting a dynamic word makes it look literal. This second spelling shows
// each expansion as `$DYNAMIC` so exemptions for literal operands still ask.
// Undefined when no word expands.
export function spellDynamic(words: (Word | string)[]): string | undefined {
  if (!words.some(expands)) return undefined;
  return words
    .map(word => (expands(word) ? '$DYNAMIC' : spell(word)))
    .join(' ');
}

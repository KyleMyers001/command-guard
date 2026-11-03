import assert from 'node:assert/strict';
import test from 'node:test';
import {neutralizeQuotedNewlines} from '../extensions/command-guard/quotes.ts';

const cases: [string, string, string][] = [
  ['no newline', "echo 'a b'", "echo 'a b'"],
  ['no quote', 'a\nb', 'a\nb'],
  ['single quotes', "x 'a\nb' y\nz", "x 'a b' y\nz"],
  ['double quotes', 'x "a\nb" y\nz', 'x "a b" y\nz'],
  ['ansi-c quotes', "x $'a\nb' y\nz", "x $'a b' y\nz"],
  ['escaped quote in ansi-c', "x $'a\\'\nb' y\nz", "x $'a\\' b' y\nz"],
  ['escaped quote outside', "x \\'a\nb", "x \\'a\nb"],
  ['escaped double quote inside', 'x "a\\"\nb" y\nz', 'x "a\\" b" y\nz'],
  ['line continuation in double quotes', 'x "a\\\nb" y', 'x "a\\ b" y'],
  ['line continuation outside', 'x \\\ny', 'x \\\ny'],
  ['single quote inside double', 'x "it\'s\na" y\nz', 'x "it\'s a" y\nz'],
  ['double quote inside single', "x 'say \"\na' y\nz", "x 'say \" a' y\nz"],
  ['comment apostrophe', "x # don't\ny 'a\nb'", "x # don't\ny 'a b'"],
  ['comment at start', "# it's\nx 'a\nb'", "# it's\nx 'a b'"],
  ['comment to end of text', "x 'a\nb' # it's", "x 'a b' # it's"],
  ['hash inside a word is not a comment', "a#b 'c\nd'", "a#b 'c d'"],
  ['unterminated quote', "x 'a\nb", "x 'a b"],
];

for (const [name, input, expected] of cases) {
  test(`neutralizeQuotedNewlines: ${name}`, () => {
    assert.equal(neutralizeQuotedNewlines(input), expected);
  });
}

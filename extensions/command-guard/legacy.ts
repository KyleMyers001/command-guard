import {matches, type CommandTexts} from './match.ts';
import type {Analysis, Decision} from './commands.ts';
import type {GuardTool, Rule} from './policy.ts';

// Reads a command the way the guard first did, for commands the scanner is
// not sure about: the stricter of both readings wins, so a command is never
// let through that the first scanner would have stopped.

// The gap in the push rules between `push` and a flag. Rules now stop it at a
// newline; the first version let it run on.
const GAP = String.raw`(?:\\\r?\n|[^;&|\n])*`;
const FIRST_GAP = String.raw`[^;&|]*`;

const firstVersions = new WeakMap<Rule, Rule>();

// `rule` as the guard first wrote it.
function firstVersion(rule: Rule): Rule {
  let first = firstVersions.get(rule);
  if (!first) {
    const {regex} = rule;
    first =
      regex && regex.source.includes(GAP)
        ? {
            ...rule,
            regex: new RegExp(
              regex.source.replaceAll(GAP, FIRST_GAP),
              regex.flags,
            ),
          }
        : rule;
    firstVersions.set(rule, first);
  }
  return first;
}

// The decisions of analysis under both readings.
export function allDecisions(analysis: Analysis | undefined): Decision[] {
  return [
    ...(analysis?.decisions ?? []),
    ...(analysis?.legacy?.decisions ?? []),
  ];
}

// A rule matches a command if it matches under either reading.
export function matchesEither(
  rule: Rule,
  tool: GuardTool,
  texts: CommandTexts,
  analysis: Analysis,
  cwd: string,
  home: string,
): boolean {
  if (matches(rule, tool, texts, cwd, home)) return true;
  if (!analysis.legacy) return false;

  const first: CommandTexts = {
    raw: texts.raw,
    canonical: analysis.legacy.canonical,
    lines: [],
  };
  return matches(firstVersion(rule), tool, first, cwd, home);
}

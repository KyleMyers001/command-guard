import { join, resolve } from "node:path";
import { canonicalPath } from "./paths.ts";
import type { GuardTool, Rule } from "./policy.ts";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Literal text with `*` replaced by the given regex source.
function wildcard(value: string, star: string): string {
  return value.split("*").map(escapeRegex).join(star);
}

// Whole-string glob where `*` matches any text, including newlines. Walks the
// text once instead of using a regex, which backtracks badly on a large
// command with several stars.
function globMatches(pattern: string, text: string): boolean {
  const pieces = pattern.split("*");
  if (pieces.length === 1) return pattern === text;

  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (!text.startsWith(first)) return false;

  let position = first.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = text.indexOf(piece, position);
    if (found < 0) return false;
    position = found + piece.length;
  }

  return text.length - last.length >= position && text.endsWith(last);
}

// Rules are written for one-line commands with single spaces. Join
// backslash-newline continuations and collapse runs of spaces and tabs.
function flattened(command: string): string {
  return command.replace(/\\\r?\n/gu, " ").replace(/[ \t]+/gu, " ");
}

// `commands` holds the command as written and its canonical spelling.
function bashMatches(rule: Rule, commands: string[]): boolean {
  const { regex, pattern } = rule;
  const spellings = commands.flatMap(command => [command, flattened(command)]);

  if (regex) return spellings.some(text => regex.test(text));
  if (pattern === undefined) return true;

  return spellings.some(text => globMatches(pattern, text));
}

// `*` stays inside one segment; a whole `**` segment spans zero or more.
function pathGlob(path: string): RegExp {
  const segments = path.split("/").filter(Boolean);

  const source = segments
    .map(segment => segment === "**"
      ? "(?:/[^/]+)*"
      : `/${wildcard(segment, "[^/]*")}`)
    .join("");

  // Case-insensitive: the default macOS volume opens `~/.SSH` as `~/.ssh`.
  return new RegExp(`^${source || "/"}$`, "iu");
}

function anchorPattern(pattern: string, cwd: string, home: string): string {
  if (pattern.startsWith("//")) return resolve("/", pattern.slice(2));
  if (pattern.startsWith("~/")) return resolve(home, pattern.slice(2));
  return resolve(cwd, pattern);
}

// A rule path as written, plus the same path with its literal prefix resolved
// through symlinks, so a rule naming a link also covers the link's target.
function policyPaths(pattern: string, cwd: string, home: string): string[] {
  const absolute = anchorPattern(pattern, cwd, home);
  const segments = absolute.split("/");
  const firstGlob = segments.findIndex(segment => segment.includes("*"));

  if (firstGlob < 0) return [absolute, canonicalPath(absolute)];

  const literalPrefix = segments.slice(0, firstGlob).join("/") || "/";
  const globSuffix = segments.slice(firstGlob);

  return [absolute, join(canonicalPath(literalPrefix), ...globSuffix)];
}

// As in Claude Code, an `Edit` rule covers every tool that changes a file.
// `Write` rules stay specific to the write tool.
function appliesTo(rule: Rule, tool: GuardTool): boolean {
  return rule.tool === tool || (rule.tool === "edit" && tool === "write");
}

export function matches(
  rule: Rule,
  tool: GuardTool,
  targets: string[],
  cwd: string,
  home: string,
): boolean {
  if (!appliesTo(rule, tool)) return false;
  if (tool === "bash") return bashMatches(rule, targets);
  if (rule.pattern === undefined) return true;

  return policyPaths(rule.pattern, cwd, home).some(pattern => {
    // macOS can resolve NFC and NFD spellings without realpath unifying them.
    const regex = pathGlob(pattern.normalize("NFC"));
    return targets.some(target => regex.test(target.normalize("NFC")));
  });
}

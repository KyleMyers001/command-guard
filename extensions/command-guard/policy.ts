import { readFileSync } from "node:fs";

export type GuardTool = "bash" | "read" | "edit" | "write";

export interface Rule {
  // The selector exactly as written in the policy, for messages.
  selector: string;
  tool: GuardTool;
  // Absent for a bare selector such as `Bash`, which matches every call.
  pattern?: string;
  // Set for `BashRegex(...)`; `pattern` then holds the regex source.
  regex?: RegExp;
}

interface Policy {
  deny: Rule[];
  ask: Rule[];
}

const selectorTools: Record<string, GuardTool> = {
  Bash: "bash",
  BashRegex: "bash",
  Read: "read",
  Edit: "edit",
  Write: "write",
};

export class PolicyError extends Error {}

// Escape control and bidirectional characters so text shown to the user or
// the model cannot redraw the terminal or disguise its own content.
export function visible(value: string): string {
  const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

  return value.replace(unsafe, char => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${hex}`;
  });
}

function expectObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError("Expected an object");
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const sameCount = Object.keys(value).length === expected.length;
  const allPresent = expected.every(key => Object.hasOwn(value, key));

  if (!sameCount || !allPresent) {
    throw new PolicyError(`Expected only keys: ${expected.join(", ")}`);
  }
}

function validateBashPattern(pattern: string): void {
  if (pattern.includes(":*")) {
    throw new PolicyError("Use * rather than Claude :* syntax");
  }
}

// Compiled once per load so a bad expression is a configuration error, not
// a failure in the middle of evaluating a command.
function compileBashRegex(source: string | undefined): RegExp {
  if (source === undefined) throw new PolicyError("BashRegex needs an expression");

  try {
    return new RegExp(source, "u");
  } catch {
    // Node 22 predates inline modifiers. Preserve the policy's supported
    // whole-expression `(?i:...)` form with an equivalent global flag.
    if (source.startsWith("(?i:") && source.endsWith(")")) {
      try {
        return new RegExp(source.slice(4, -1), "iu");
      } catch {
        // Fall through to the policy-safe error below.
      }
    }
    throw new PolicyError("BashRegex expression is not a valid regular expression");
  }
}

function validateFilePattern(pattern: string): void {
  const segments = pattern.split("/");

  const ambiguousRoot = pattern.startsWith("/") && !pattern.startsWith("//");
  const otherUsersHome = pattern.startsWith("~") && !pattern.startsWith("~/");
  const unsupportedSyntax = /[?\x5b\]{}\\()]/u.test(pattern);
  const parentSegment = segments.includes("..");
  const partialRecursiveStar = segments
    .some(segment => segment.includes("**") && segment !== "**");

  if (ambiguousRoot || otherUsersHome || unsupportedSyntax
      || parentSegment || partialRecursiveStar) {
    throw new PolicyError("File rules support ~/, //, relative paths, * and ** segments only; no .. or escaping");
  }
}

function parseRule(value: unknown): Rule {
  if (typeof value !== "string") throw new PolicyError("Selectors must be strings");

  const match = /^([A-Za-z]+)(?:\(([\s\S]+)\))?$/u.exec(value);
  const tool = match && Object.hasOwn(selectorTools, match[1])
    ? selectorTools[match[1]]
    : undefined;
  if (!tool) {
    throw new PolicyError("Supported selectors: Bash, BashRegex, Read, Edit, Write");
  }

  const pattern = match?.[2];
  if (pattern?.includes("\0")) throw new PolicyError("NUL is not supported");

  if (match?.[1] === "BashRegex") {
    return { selector: value, tool, pattern, regex: compileBashRegex(pattern) };
  }

  if (pattern !== undefined) {
    if (tool === "bash") validateBashPattern(pattern);
    else validateFilePattern(pattern);
  }

  return { selector: value, tool, pattern };
}

// Re-read on every call so manual policy edits apply without a reload.
export function loadPolicy(path: string): Policy {
  try {
    const data = expectObject(JSON.parse(readFileSync(path, "utf8")));
    expectExactKeys(data, ["version", "permissions"]);
    if (data.version !== 1) throw new PolicyError("Expected version 1");

    const permissions = expectObject(data.permissions);
    expectExactKeys(permissions, ["deny", "ask"]);
    if (!Array.isArray(permissions.deny) || !Array.isArray(permissions.ask)) {
      throw new PolicyError("deny and ask must both be arrays");
    }

    return {
      deny: permissions.deny.map(parseRule),
      ask: permissions.ask.map(parseRule),
    };
  } catch (error) {
    // Parser and filesystem messages can quote file contents; keep them out.
    const detail = error instanceof PolicyError
      ? error.message
      : "Cannot read or parse JSON";
    throw new PolicyError(`Policy configuration error at ${visible(path)}: ${detail}. Repair externally.`);
  }
}

// One POSIX-ERE regex per line, shared with the other agents' guards.
export function loadShared(path: string): RegExp[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(line => new RegExp(line.replaceAll("[:space:]", "\\s"), "m"));
  } catch {
    throw new PolicyError(`Shared policy configuration error at ${visible(path)}. Repair externally.`);
  }
}

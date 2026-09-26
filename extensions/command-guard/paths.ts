import { accessSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyError, type GuardTool } from "./policy.ts";

const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

function errorCode(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  return "code" in error ? error.code : undefined;
}

// Resolve existing ancestors, but never treat a dangling symlink as a new file.
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new PolicyError("Cannot resolve path safely");
    }
  }

  try {
    lstatSync(path);
    throw new PolicyError("Cannot resolve dangling symlink safely");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const parent = dirname(path);
  if (parent === path) throw new PolicyError("Cannot resolve filesystem root");

  return join(canonicalPath(parent), path.slice(parent.length));
}

// Mirrors how Pi turns a tool's path argument into an absolute path.
export function normalizeInput(path: string, cwd: string, home: string): string {
  let normalized = path.replace(unicodeSpaces, " ").replace(/^@/u, "");

  if (normalized === "~") {
    normalized = home;
  } else if (normalized.startsWith("~/")) {
    normalized = join(home, normalized.slice(2));
  }

  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);

  return resolve(cwd, normalized);
}

function exists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new PolicyError("Cannot inspect read path safely");
    }
    return false;
  }
}

// Mirrors Pi's read fallback order; parity fixtures pin this to installed Pi.
function readPath(path: string): string {
  const nfd = path.normalize("NFD");
  const curlyQuotes = (value: string) => value.replace(/'/gu, "\u2019");
  const narrowSpaceBeforeMeridiem = path.replace(/ (AM|PM)\./giu, "\u202f$1.");

  const candidates = [
    path,
    narrowSpaceBeforeMeridiem,
    nfd,
    curlyQuotes(path),
    curlyQuotes(nfd),
  ];

  return candidates.find(exists) ?? path;
}

// Every spelling a rule must be checked against: the path as requested, the
// path Pi would actually open, and the symlink-resolved form of each.
export function inputPaths(
  tool: GuardTool,
  path: string,
  cwd: string,
  home: string,
): string[] {
  const requested = normalizeInput(path, cwd, home);
  const actual = tool === "read" ? readPath(requested) : requested;

  return [...new Set([
    requested,
    actual,
    canonicalPath(requested),
    canonicalPath(actual),
  ])];
}

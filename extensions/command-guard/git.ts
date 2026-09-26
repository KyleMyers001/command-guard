import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Decision } from "./commands.ts";
import type { Word } from "./shell.ts";

const GIT_VALUE_OPTIONS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
  "--config-env",
]);

const PROTECTED_BRANCHES = new Set(["main", "master", "prod", "production", "release"]);

const PUSH_FLAGS = new Set([
  "--set-upstream", "--verbose", "--quiet", "--progress", "--no-progress",
  "--dry-run", "--porcelain", "--atomic",
]);
const PUSH_SHORT_FLAGS = new Set(["u", "v", "q", "n"]);
const PUSH_FORCE = /^--force(-with-lease|-if-includes)?(=|$)/u;
const PUSH_BULK = new Set(["--all", "--mirror", "--branches", "--prune"]);

const deny = (reason: string, advice?: string): Decision => ({ verdict: "deny", reason, advice });

const PUSH_FORCED = deny("git push with a force option or + refspec can rewrite remote history");
const PUSH_DELETES = deny("git push that deletes a remote ref");
const PUSH_BULK_UPDATE = deny("git push of many refs at once (--all, --mirror, --branches, --prune, or a wildcard refspec)");
const PUSH_PROTECTED = deny("git push updates a protected branch (main, master, prod, production, release)");
const PUSH_UNANALYZED = deny("git push uses an option or ref namespace the command guard does not analyze");
const PUSH_UNRESOLVED = deny(
  "git push needs an explicit remote and a literal destination branch; implicit, HEAD-only, and computed destinations are never allowed",
  "Name the feature branch, for example: git push -u origin feat/example",
);
const CHECKOUT_OVERWRITES: Decision = {
  verdict: "ask",
  reason: "git checkout of paths or with force can discard uncommitted work",
};
const RESTORE_OVERWRITES: Decision = {
  verdict: "ask",
  reason: "git restore overwrites working tree files unless --staged limits it to the index",
};

// Only the destination side of a refspec decides what is updated.
function classifyRefspec(refspec: string): Decision | undefined {
  if (refspec.startsWith("+")) return PUSH_FORCED;
  if (refspec.includes("*")) return PUSH_BULK_UPDATE;

  const parts = refspec.split(":");
  if (parts.length > 2) return PUSH_UNRESOLVED;
  if (parts.length === 2 && parts[0] === "") {
    return parts[1] === "" ? PUSH_BULK_UPDATE : PUSH_DELETES;
  }

  const destination = parts[parts.length - 1];
  if (destination === "" || destination === "HEAD" || destination === "@") {
    return PUSH_UNRESOLVED;
  }

  // Git completes an abbreviated destination against the remote's refs, so
  // `heads/main` reaches `refs/heads/main` just as `main` does. The full ref
  // `refs/heads/heads/main` is a different branch and keeps its name here.
  // Lowercased: refs differing only in case collide on macOS checkouts.
  const branch = destination.toLowerCase().replace(/^(refs\/)?heads\//u, "");
  if (branch.startsWith("refs/")) return PUSH_UNANALYZED;
  if (PROTECTED_BRANCHES.has(branch)) return PUSH_PROTECTED;

  return undefined;
}

function classifyPush(args: Word[]): Decision[] {
  if (args.some(arg => arg.text === "--help" || arg.text === "-h")) return [];

  const decisions: Decision[] = [];
  const positionals: Word[] = [];
  let optionsEnded = false;

  for (const arg of args) {
    const { text } = arg;
    const isOption = !optionsEnded && text.startsWith("-") && text.length > 1;

    if (!isOption) positionals.push(arg);
    else if (text === "--") optionsEnded = true;
    else if (PUSH_FORCE.test(text)) decisions.push(PUSH_FORCED);
    else if (text === "--delete") decisions.push(PUSH_DELETES);
    else if (PUSH_BULK.has(text)) decisions.push(PUSH_BULK_UPDATE);
    else if (text.startsWith("--")) {
      if (!PUSH_FLAGS.has(text)) decisions.push(PUSH_UNANALYZED);
    } else {
      // Bundled short flags such as -fu.
      for (const flag of text.slice(1)) {
        if (flag === "f") decisions.push(PUSH_FORCED);
        else if (flag === "d") decisions.push(PUSH_DELETES);
        else if (!PUSH_SHORT_FLAGS.has(flag)) decisions.push(PUSH_UNANALYZED);
      }
    }
  }

  // The first positional is the remote; a destination must follow it.
  const refspecs = positionals.slice(1);
  const bulk = decisions.includes(PUSH_BULK_UPDATE);
  if (args.some(arg => arg.dynamic) || (refspecs.length === 0 && !bulk)) {
    decisions.push(PUSH_UNRESOLVED);
  }

  for (const refspec of refspecs) {
    const decision = classifyRefspec(refspec.text);
    if (decision) decisions.push(decision);
  }

  return decisions;
}

const CHECKOUT_VALUE_OPTIONS = new Set(["-b", "--orphan"]);
const CHECKOUT_SAFE_OPTIONS = new Set([
  "-b", "--orphan", "-t", "--track", "--no-track", "--detach", "-q", "--quiet",
  "--progress", "--no-progress", "--guess", "--no-guess", "-l",
  "--recurse-submodules", "--no-recurse-submodules",
]);

function looksLikePath(operand: string): boolean {
  // A leading ./~: or trailing slash, a glob, or a file extension.
  return /^[.\/~:]|\/$|[*?\[]|\.[A-Za-z][A-Za-z0-9]*$/u.test(operand);
}

// `git checkout <operand>` switches branches when the operand is a ref and
// overwrites files when it is a path. Without running Git the two cannot be
// told apart for certain, so anything that may be a path asks. `workdirs` are
// the directories Git may run in; undefined when that cannot be known.
function classifyCheckout(args: Word[], workdirs: string[] | undefined): Decision[] {
  const operands: Word[] = [];

  for (let i = 0; i < args.length; i++) {
    const { text } = args[i];

    if (text === "-" || !text.startsWith("-")) operands.push(args[i]);
    else if (!CHECKOUT_SAFE_OPTIONS.has(text) && !text.startsWith("--track=")) {
      return [CHECKOUT_OVERWRITES];
    }

    if (CHECKOUT_VALUE_OPTIONS.has(text)) i++;
  }

  const createsBranch = args.some(arg => CHECKOUT_VALUE_OPTIONS.has(arg.text));
  if (operands.length === 0 || (createsBranch && operands.length === 1)) return [];
  if (operands.length > 1) return [CHECKOUT_OVERWRITES];

  const [operand] = operands;
  if (operand.text === "-") return [];

  const mayBePath = operand.dynamic
    || looksLikePath(operand.text)
    || workdirs === undefined
    || workdirs.some(dir => existsSync(resolve(dir, operand.text)));
  return mayBePath ? [CHECKOUT_OVERWRITES] : [];
}

const RESTORE_INDEX_SAFE_OPTIONS = new Set(["--quiet", "--progress", "--no-progress"]);

// `git restore` overwrites working tree files unless `--staged` is given
// without `--worktree`. Only that index-only form goes unasked, and only
// when every option is understood.
function classifyRestore(args: Word[]): Decision[] {
  let staged = false;

  for (let i = 0; i < args.length; i++) {
    const { text, dynamic } = args[i];

    // Everything after `--` is a filename, even one spelled like a flag.
    if (text === "--") break;
    // A dynamic word may expand to --worktree.
    if (dynamic) return [RESTORE_OVERWRITES];
    if (!text.startsWith("-") || text === "-") continue;

    if (text === "--staged") staged = true;
    else if (text === "--source") i++;
    else if (text.startsWith("--")) {
      const known = text.startsWith("--source=") || RESTORE_INDEX_SAFE_OPTIONS.has(text);
      if (!known) return [RESTORE_OVERWRITES];
    } else {
      // Bundled short flags such as -qS. `-s` takes the rest of the bundle,
      // or the next word, as its source.
      for (let at = 1; at < text.length; at++) {
        if (text[at] === "S") staged = true;
        else if (text[at] === "s") {
          if (at === text.length - 1) i++;
          break;
        } else if (text[at] !== "q") return [RESTORE_OVERWRITES];
      }
    }
  }

  return staged ? [] : [RESTORE_OVERWRITES];
}

// Git's options before the subcommand, removed. `dirs` collects `-C` values;
// it is undefined when the options leave Git's directory unknown.
export function withoutGitGlobals(args: Word[]): { rest: Word[]; dirs: string[] | undefined } {
  const dirs: string[] = [];
  let known = true;
  let i = 0;

  // A dynamic word here may expand to options, never to a known subcommand.
  while (i < args.length && (args[i].dynamic || args[i].text.startsWith("-"))) {
    const { text, dynamic } = args[i];
    const hasValue = GIT_VALUE_OPTIONS.has(text);

    if (text === "-C" && args[i + 1] && !args[i + 1].dynamic) dirs.push(args[i + 1].text);
    else if (dynamic || text === "-C" || /^--work-tree(=|$)/u.test(text)) known = false;

    i += hasValue ? 2 : 1;
  }

  return { rest: args.slice(i), dirs: known ? dirs : undefined };
}

// `args` start at the subcommand; `workdirs` are where Git may run.
export function classifyGit(args: Word[], workdirs: string[] | undefined): Decision[] {
  const [subcommand, ...rest] = args;
  if (subcommand?.text === "push") return classifyPush(rest);
  if (subcommand?.text === "checkout") return classifyCheckout(rest, workdirs);
  if (subcommand?.text === "restore") return classifyRestore(rest);
  return [];
}

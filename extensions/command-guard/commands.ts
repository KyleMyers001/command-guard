import { basename, resolve } from "node:path";
import { classifyGit, withoutGitGlobals } from "./git.ts";
import { expandScripts } from "./scripts.ts";
import { parseSegments, type Word } from "./shell.ts";

// Decisions made from a command's decoded arguments rather than its text.
// Reasons are fixed strings: they are shown to the model and must never
// carry command content.
export interface Decision {
  verdict: "deny" | "ask";
  reason: string;
  // Replaces the default "do not retry" advice when a safe form exists.
  advice?: string;
}

export interface Analysis {
  // One line per simple command, spelled without quoting, executable paths,
  // or Git and GitHub global options, so text rules written for the plain
  // spelling (`gh pr merge`) also match `gh -R owner/repo pr merge`.
  canonical: string;
  decisions: Decision[];
}

const TOOLS = new Set(["git", "gh", "kubectl", "helm"]);
// More candidate directories than this count as not knowing the directory.
const MAX_WORKDIRS = 8;

const KUBECTL_DRY_RUNS = new Set(["--dry-run=client", "--dry-run=server"]);
const KUBECTL_MUTATIONS = new Set(["delete", "apply", "replace", "patch", "scale", "drain", "cordon"]);
const KUBECTL_ROLLOUT_MUTATIONS = new Set(["restart", "undo"]);
const HELM_MUTATIONS = new Set(["delete", "uninstall", "install", "upgrade", "rollback"]);

const KUBECTL_MUTATES: Decision = {
  verdict: "ask",
  reason: "kubectl command changes cluster state; only a single --dry-run=client or --dry-run=server is exempt",
};
const HELM_MUTATES: Decision = {
  verdict: "ask",
  reason: "helm command changes a release; dry-run flags are not trusted because their meaning varies by Helm version",
};

function classifyKubectl(args: Word[]): Decision[] {
  const mutates = args.some((arg, i) => KUBECTL_MUTATIONS.has(arg.text)
    || (arg.text === "rollout" && KUBECTL_ROLLOUT_MUTATIONS.has(args[i + 1]?.text)));
  if (!mutates) return [];

  // `--dry-run=none` runs for real, and a repeated flag is ambiguous.
  const dryRuns = args.filter(arg => arg.text.startsWith("--dry-run"));
  const isDryRun = dryRuns.length === 1
    && !dryRuns[0].dynamic
    && KUBECTL_DRY_RUNS.has(dryRuns[0].text);
  return isDryRun ? [] : [KUBECTL_MUTATES];
}

function classifyHelm(args: Word[]): Decision[] {
  return args.some(arg => HELM_MUTATIONS.has(arg.text)) ? [HELM_MUTATES] : [];
}

// `gh` accepts its repository option anywhere, including before the command.
function withoutGhRepo(args: Word[]): Word[] {
  const rest: Word[] = [];

  for (let i = 0; i < args.length; i++) {
    const { text } = args[i];
    if (text === "-R" || text === "--repo") i++;
    else if (!/^(-R.|--repo=)/u.test(text)) rest.push(args[i]);
  }

  return rest;
}

const GH_API_VALUE_OPTIONS = new Set([
  "--method", "--field", "--raw-field", "--header", "--jq", "--template",
  "--input", "--preview", "--hostname", "--cache",
]);

// `gh api -XPUT -ftitle=x` respelled `-X PUT -f title=x`, the spelling text
// rules are written for. Only whole option words change: values of other
// options, the endpoint, and words after `--` stay as written.
function withSeparateApiValues(args: Word[]): Word[] {
  if (args[0]?.text !== "api") return args;
  const rest: Word[] = [];

  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word.text === "--") return [...rest, ...args.slice(i)];

    // `-i` is the only short flag without a value, so it may lead a bundle.
    const short = /^-(i*)([XfFHqtp])=?(.*)$/u.exec(word.text);
    if (short?.[3]) {
      for (const _ of short[1]) rest.push({ text: "-i", dynamic: false });
      rest.push({ text: `-${short[2]}`, dynamic: false });
      rest.push({ text: short[3], dynamic: word.dynamic });
      continue;
    }

    rest.push(word);
    const valueFollows = short !== null || GH_API_VALUE_OPTIONS.has(word.text);
    if (valueFollows && i + 1 < args.length) rest.push(args[++i]);
  }

  return rest;
}

// Where later commands may run once this one has. The shell's control flow
// is not followed: a literal `cd` adds its target to the directories it may
// have been run from. Undefined means the directory cannot be known.
function workdirsAfter(segment: Word[], workdirs: string[] | undefined): string[] | undefined {
  const [command, target, ...extra] = segment;
  if (command.dynamic || !["cd", "pushd", "popd"].includes(command.text)) return workdirs;

  const isLiteral = command.text === "cd" && target !== undefined && extra.length === 0
    && !target.dynamic && !/^[-~]/u.test(target.text);
  if (!workdirs || !isLiteral) return undefined;

  const reached = workdirs.map(dir => resolve(dir, target.text));
  const all = [...new Set([...workdirs, ...reached])];
  return all.length > MAX_WORKDIRS ? undefined : all;
}

function spell(word: Word): string {
  if (/^[A-Za-z0-9_@%+=:,.\/~^-]+$/u.test(word.text)) return word.text;
  return `'${word.text.replaceAll("'", "'\\''")}'`;
}

export function analyzeCommand(command: string, cwd: string): Analysis {
  const lines: string[] = [];
  const { segments, decisions } = expandScripts(parseSegments(command));
  let workdirs: string[] | undefined = [cwd];

  for (const segment of segments) {
    // Before the tool lookup: `cd repo/git` names a tool but runs none.
    workdirs = workdirsAfter(segment, workdirs);

    // Wrappers such as `env X=1` or `time` come before the tool's own word.
    const at = segment.findIndex(word => !word.dynamic && TOOLS.has(basename(word.text)));
    if (at < 0) {
      lines.push(segment.map(spell).join(" "));
      continue;
    }

    const tool = basename(segment[at].text);
    let args = segment.slice(at + 1);

    if (tool === "git") {
      const { rest, dirs } = withoutGitGlobals(args);
      const movesWorkTree = segment.slice(0, at).some(word => word.text.startsWith("GIT_WORK_TREE="));
      const gitDirs = dirs && !movesWorkTree
        ? workdirs?.map(dir => resolve(dir, ...dirs))
        : undefined;
      args = rest;
      decisions.push(...classifyGit(args, gitDirs));
    } else if (tool === "gh") {
      args = withSeparateApiValues(withoutGhRepo(args));
    } else if (tool === "kubectl") {
      decisions.push(...classifyKubectl(args));
    } else {
      decisions.push(...classifyHelm(args));
    }

    lines.push([...segment.slice(0, at).map(spell), tool, ...args.map(spell)].join(" "));
  }

  return { canonical: lines.join("\n"), decisions };
}

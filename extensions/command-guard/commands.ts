import {basename, resolve} from 'node:path';
import {classifyGit, withoutGitGlobals} from './git.ts';
import {ghArgs} from './gh.ts';
import {invocationViews, spell} from './invocations.ts';
import {pipesToShell} from './pipeline.ts';
import {classifyPublish} from './publish.ts';
import {expandScripts} from './scripts.ts';
import {parseSegments, type ShellMode, type Word} from './shell.ts';

// Decisions made from a command's decoded arguments rather than its text.
// Reasons are fixed strings: they are shown to the model and must never
// carry command content.
export interface Decision {
  verdict: 'deny' | 'ask';
  reason: string;
  // Replaces the default "do not retry" advice when a safe form exists.
  advice?: string;
}

export interface Analysis {
  // One line per simple command, spelled without quoting, executable paths,
  // or Git and GitHub global options, so text rules written for the plain
  // spelling (`gh pr merge`) also match `gh -R owner/repo pr merge`.
  canonical: string;
  // The same lines one by one. Raw rules read them separately, so a gap such as
  // `[^;&|]*` cannot run from one command into the next.
  lines: string[];
  decisions: Decision[];
  // Set when the command holds a construct the scanner cannot be sure of (a
  // process substitution, an unterminated quote, an unusual operator...): the
  // same command as the guard's first scanner read it. Callers apply their
  // rules to both readings and take the stricter result.
  legacy?: {canonical: string; decisions: Decision[]};
  // One line per simple command as it would be started: see invocations.ts.
  // Built on first read, so a policy with no `BashCmdRegex` rule never pays for
  // it. Undefined when there is no view (a large or deeply nested command, or
  // a script that cannot be read). A `BashCmdRegex` rule then matches.
  readonly invocations?: string[];
}

const TOOLS = new Set(['git', 'gh', 'kubectl', 'helm']);
// More candidate directories than this count as not knowing the directory.
const MAX_WORKDIRS = 8;

const KUBECTL_DRY_RUNS = new Set(['--dry-run=client', '--dry-run=server']);
const KUBECTL_MUTATIONS = new Set([
  'delete',
  'apply',
  'replace',
  'patch',
  'scale',
  'drain',
  'cordon',
]);
const KUBECTL_ROLLOUT_MUTATIONS = new Set(['restart', 'undo']);
const HELM_MUTATIONS = new Set([
  'delete',
  'uninstall',
  'install',
  'upgrade',
  'rollback',
]);

const PIPE_TO_SHELL: Decision = {
  verdict: 'deny',
  reason: 'a download is piped into a shell, which runs it unseen',
  advice: 'Download the script to a file, read it, then run it.',
};
const KUBECTL_MUTATES: Decision = {
  verdict: 'ask',
  reason:
    'kubectl command changes cluster state; only a single --dry-run=client or --dry-run=server is exempt',
};
const HELM_MUTATES: Decision = {
  verdict: 'ask',
  reason:
    'helm command changes a release; dry-run flags are not trusted because their meaning varies by Helm version',
};

function classifyKubectl(args: Word[]): Decision[] {
  const mutates = args.some(
    (arg, i) =>
      KUBECTL_MUTATIONS.has(arg.text) ||
      (arg.text === 'rollout' &&
        KUBECTL_ROLLOUT_MUTATIONS.has(args[i + 1]?.text)),
  );
  if (!mutates) return [];

  // `--dry-run=none` runs for real, and a repeated flag is ambiguous.
  const dryRuns = args.filter(arg => arg.text.startsWith('--dry-run'));
  const isDryRun =
    dryRuns.length === 1 &&
    !dryRuns[0].dynamic &&
    KUBECTL_DRY_RUNS.has(dryRuns[0].text);
  return isDryRun ? [] : [KUBECTL_MUTATES];
}

function classifyHelm(args: Word[]): Decision[] {
  return args.some(arg => HELM_MUTATIONS.has(arg.text)) ? [HELM_MUTATES] : [];
}

// Where later commands may run once this one has. The shell's control flow
// is not followed: a literal `cd` adds its target to the directories it may
// have been run from. Undefined means the directory cannot be known.
function workdirsAfter(
  segment: Word[],
  workdirs: string[] | undefined,
): string[] | undefined {
  const [command, target, ...extra] = segment;
  if (command.dynamic || !['cd', 'pushd', 'popd'].includes(command.text))
    return workdirs;

  const isLiteral =
    command.text === 'cd' &&
    target !== undefined &&
    extra.length === 0 &&
    !target.dynamic &&
    !/^[-~]/u.test(target.text);
  if (!workdirs || !isLiteral) return undefined;

  const reached = workdirs.map(dir => resolve(dir, target.text));
  const all = [...new Set([...workdirs, ...reached])];
  return all.length > MAX_WORKDIRS ? undefined : all;
}

export function analyzeCommand(command: string, cwd: string): Analysis {
  const mode: ShellMode = {legacy: false, uncertain: false};
  const analysis = analyzeWith(command, cwd, mode);
  if (!mode.uncertain) return analysis;

  const {canonical, decisions} = analyzeWith(command, cwd, {
    legacy: true,
    uncertain: false,
  });
  return {...analysis, legacy: {canonical, decisions}};
}

function analyzeWith(command: string, cwd: string, mode: ShellMode): Analysis {
  const lines: string[] = [];
  const {segments, decisions, scripts} = expandScripts(
    parseSegments(command, mode),
    mode,
  );
  let workdirs: string[] | undefined = [cwd];

  for (const segment of segments) {
    // Before the tool lookup: `cd repo/git` names a tool but runs none.
    workdirs = workdirsAfter(segment, workdirs);
    decisions.push(...classifyPublish(segment));

    // Wrappers such as `env X=1` or `time` come before the tool's own word.
    const at = segment.findIndex(
      word => !word.dynamic && TOOLS.has(basename(word.text)),
    );
    if (at < 0) {
      lines.push(segment.map(spell).join(' '));
      continue;
    }

    const tool = basename(segment[at].text);
    let args = segment.slice(at + 1);

    if (tool === 'git') {
      const {rest, dirs} = withoutGitGlobals(args);
      const movesWorkTree = segment
        .slice(0, at)
        .some(word => word.text.startsWith('GIT_WORK_TREE='));
      const gitDirs =
        dirs && !movesWorkTree
          ? workdirs?.map(dir => resolve(dir, ...dirs))
          : undefined;
      args = rest;
      decisions.push(...classifyGit(args, gitDirs));
    } else if (tool === 'gh') {
      args = ghArgs(args);
    } else if (tool === 'kubectl') {
      decisions.push(...classifyKubectl(args));
    } else {
      decisions.push(...classifyHelm(args));
    }

    lines.push(
      [...segment.slice(0, at).map(spell), tool, ...args.map(spell)].join(' '),
    );
  }

  // The segments no longer show a pipeline, so read the text of the command
  // and of each literal shell string.
  if ([command, ...scripts].some(pipesToShell)) decisions.push(PIPE_TO_SHELL);

  let views: string[] | undefined;
  let built = false;

  return {
    canonical: lines.join('\n'),
    lines,
    decisions,
    get invocations() {
      if (!built) {
        views = invocationViews(segments);
        built = true;
      }
      return views;
    },
  };
}

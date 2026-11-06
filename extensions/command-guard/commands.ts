import {basename, resolve} from 'node:path';
import {classifyGit, withoutGitGlobals} from './git.ts';
import {ghArgs} from './gh.ts';
import {classifyHelm, classifyKubectl} from './kube.ts';
import {pipesToShell} from './pipeline.ts';
import {classifyPublish, runsOutput} from './publish.ts';
import {expandScripts} from './scripts.ts';
import {spell, spellDynamic} from './spelling.ts';
import {exemptTexts} from './gate.ts';
import type {CommandTexts} from './match.ts';
import {parseCommand, type ShellMode, type Word} from './shell.ts';

// Decisions made from a command's decoded arguments rather than its text.
// Reasons are fixed strings: they are shown to the model and must never
// carry command content.
export interface Decision {
  verdict: 'deny' | 'ask';
  reason: string;
  // Replaces the default "do not retry" advice when a safe form exists.
  advice?: string;
  // An ask that does not apply to a command that may use the exemptions.
  exemptible?: boolean;
}

export interface Analysis {
  // One line per simple command, without executable paths or tool globals.
  canonical: string;
  // Canonical commands separately, for raw rules that must not span commands.
  lines: string[];
  decisions: Decision[];
  // Uncertain scans also retain the original scanner's stricter decisions.
  legacy?: {canonical: string; decisions: Decision[]};
  // What the ask rules read instead when the command may use the exemptions
  // (gate.ts). Never set for an uncertain scan.
  exempt?: CommandTexts;
}

export interface AnalyzeOptions {
  // Whether a curl config file could redirect a download. Fails closed.
  curlrcRisky?: () => boolean;
}

const TOOLS = new Set(['git', 'gh', 'kubectl', 'helm']);
const MAX_WORKDIRS = 8;
const PIPE_TO_SHELL: Decision = {
  verdict: 'deny',
  reason: 'a download is piped into a shell, which runs it unseen',
  advice: 'Download the script to a file, read it, then run it.',
};

// Where later commands may run once this one has. The shell's control flow
// is not followed: a literal cd adds its target to the possible directories.
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

export function analyzeCommand(
  command: string,
  cwd: string,
  options: AnalyzeOptions = {},
): Analysis {
  const curlrcRisky = options.curlrcRisky ?? (() => true);
  const mode: ShellMode = {legacy: false, uncertain: false};
  const analysis = analyzeWith(command, cwd, mode, curlrcRisky);
  if (!mode.uncertain) return analysis;

  const {canonical, decisions} = analyzeWith(
    command,
    cwd,
    {legacy: true, uncertain: false},
    curlrcRisky,
  );
  return {...analysis, legacy: {canonical, decisions}};
}

function analyzeWith(
  command: string,
  cwd: string,
  mode: ShellMode,
  curlrcRisky: () => boolean,
): Analysis {
  const lines: string[] = [];
  const parsed = parseCommand(command, mode);
  const {segments, decisions, scripts} = expandScripts(parsed.segments, mode);
  let workdirs: string[] | undefined = [cwd];
  let runs: boolean | undefined;
  const runsCommandOutput = () => (runs ??= runsOutput(command));

  for (const segment of segments) {
    workdirs = workdirsAfter(segment, workdirs);
    decisions.push(...classifyPublish(segment, runsCommandOutput));

    // Before the tool lookup: cd repo/git names a tool but runs none.
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
      const {rest, dirs, plain} = withoutGitGlobals(args);
      const movesWorkTree = segment
        .slice(0, at)
        .some(word => word.text.startsWith('GIT_WORK_TREE='));
      const gitDirs =
        dirs && !movesWorkTree
          ? workdirs?.map(dir => resolve(dir, ...dirs))
          : undefined;
      args = rest;
      decisions.push(...classifyGit(args, gitDirs, plain));
      // Narrowed ask rules must still see unsafe globals after normalization.
      if (!plain)
        lines.push(['git', '--global-options', ...args.map(spell)].join(' '));
    } else if (tool === 'gh') {
      args = ghArgs(args);
    } else if (tool === 'kubectl') {
      decisions.push(...classifyKubectl(args));
    } else {
      decisions.push(...classifyHelm(args));
    }

    const prefix = segment.slice(0, at);
    lines.push([...prefix.map(spell), tool, ...args.map(spell)].join(' '));
    const spelledDynamic = spellDynamic([...prefix, tool, ...args]);
    if (spelledDynamic) lines.push(spelledDynamic);
  }

  // The segments no longer show pipes, so inspect literal script texts too.
  if ([command, ...scripts].some(pipesToShell)) decisions.push(PIPE_TO_SHELL);

  const exempt = mode.uncertain
    ? undefined
    : exemptTexts(command, cwd, parsed, segments, curlrcRisky);
  return {
    canonical: lines.join('\n'),
    lines,
    decisions,
    ...(exempt && {exempt}),
  };
}

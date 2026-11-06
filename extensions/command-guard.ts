import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeCommand} from './command-guard/commands.ts';
import {allDecisions, matchesEither} from './command-guard/legacy.ts';
import {matches} from './command-guard/match.ts';
import {canonicalPath, inputPaths} from './command-guard/paths.ts';
import {
  loadPolicy,
  PolicyError,
  visible,
  type GuardTool,
  type Rule,
} from './command-guard/policy.ts';
import {
  block,
  requestApproval,
  type Invocation,
} from './command-guard/request.ts';

const home = homedir();

// Resolve the entrypoint first: Pi may load it through a legacy symlink.
const extensionPath = canonicalPath(fileURLToPath(import.meta.url));
const extensionDir = dirname(extensionPath);
const policyPath = join(extensionDir, '../command-guard.json');

const legacyFiles = [join(home, '.pi/agent/extensions/command-guard.ts')];

// Helper modules are protected by directory, so a new one needs no entry here.
const protectedDirs = [
  join(extensionDir, 'command-guard'),
  join(home, '.pi/agent/extensions/command-guard'),
];

interface GuardOptions {
  policyPath?: string;
  homeDir?: string;
  // Test seams: environment (approval timeout) and monotonic clock (expiry detection).
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function supported(tool: string): tool is GuardTool {
  return (
    tool === 'bash' || tool === 'read' || tool === 'edit' || tool === 'write'
  );
}

// The default macOS volume ignores case and treats NFC and NFD alike, so a
// differently spelled path can still open a protected file.
function comparable(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function withCanonical(paths: string[]): string[] {
  return paths.flatMap(path => [path, canonicalPath(path)]).map(comparable);
}

function isGuardOwned(targets: string[], protectedFiles: string[]): boolean {
  const files = withCanonical(protectedFiles);
  const dirs = withCanonical(protectedDirs);

  return targets
    .map(comparable)
    .some(
      target =>
        files.includes(target) ||
        dirs.some(dir => target.startsWith(`${dir}/`)),
    );
}

export function createCommandGuard(options: GuardOptions = {}) {
  const policyFile = options.policyPath ?? policyPath;
  const homeDir = options.homeDir ?? home;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => performance.now());

  // Test policy paths are additive: injection cannot remove production protections.
  const protectedFiles = [
    ...new Set([
      policyPath,
      policyFile,
      extensionPath,
      join(extensionDir, '../package.json'),
      ...legacyFiles,
    ]),
  ];

  async function evaluate(
    tool: GuardTool,
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> {
    if (ctx.signal?.aborted) return block('Invocation cancelled.');

    const input: Record<string, unknown> = event.input;
    const target = tool === 'bash' ? input.command : input.path;
    if (
      typeof target !== 'string' ||
      target.length === 0 ||
      target.includes('\0')
    ) {
      return block('Invalid command-guard tool input.');
    }

    // Bash is judged by its decoded arguments as well as by its text.
    const analysis =
      tool === 'bash' ? analyzeCommand(target, ctx.cwd) : undefined;
    const targets = analysis
      ? [target, analysis.canonical]
      : inputPaths(tool, target, ctx.cwd, homeDir);
    const texts = analysis && {
      raw: target,
      canonical: analysis.canonical,
      lines: analysis.lines,
    };
    const call: Invocation = {tool, input, target, targets};

    // 1. Built-in protection, before any mutable configuration is consulted.
    const mutates = tool === 'edit' || tool === 'write';
    if (mutates && isGuardOwned(targets, protectedFiles)) {
      return block(
        'Guard-owned file is protected. Make policy changes manually outside Pi.',
      );
    }

    // 2. The policy loads before any verdict below, so a broken one blocks even
    // a command that analysis alone would let through.
    const policy = loadPolicy(policyFile);
    const matchesCall = (rule: Rule) =>
      texts && analysis
        ? matchesEither(rule, tool, texts, analysis, ctx.cwd, homeDir)
        : matches(rule, tool, targets, ctx.cwd, homeDir);
    const decisions = allDecisions(analysis);

    // 3. Command-analysis and JSON denies, which no approval can override.
    const refused = decisions.find(decision => decision.verdict === 'deny');
    if (refused) {
      return block(
        `Denied by command guard: ${refused.reason}.`,
        refused.advice,
      );
    }

    const denied = policy.deny.find(matchesCall);
    if (denied) {
      return block(`Denied by JSON deny selector ${visible(denied.selector)}.`);
    }

    // 4. Command-analysis and JSON asks. 5. Otherwise the call proceeds.
    const questioned = decisions.find(decision => decision.verdict === 'ask');
    if (questioned) {
      return requestApproval(
        `Reason: ${questioned.reason}`,
        call,
        event,
        ctx,
        env,
        now,
      );
    }

    const asked = policy.ask.find(matchesCall);
    if (!asked) return undefined;

    return requestApproval(
      `Rule: ${asked.selector}`,
      call,
      event,
      ctx,
      env,
      now,
    );
  }

  return async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    const tool = event.toolName;
    if (!supported(tool)) return undefined;

    try {
      return await evaluate(tool, event, ctx);
    } catch (error) {
      // Fail closed without echoing unexpected error text to the model.
      return block(
        error instanceof PolicyError
          ? error.message
          : 'Command guard could not evaluate this invocation safely. Check configuration externally.',
      );
    }
  };
}

export default function commandGuard(pi: ExtensionAPI): void {
  pi.on('tool_call', createCommandGuard());

  pi.on('session_start', (_event, ctx) => {
    // Clear status left by older versions without adding persistent footer noise.
    if (ctx.hasUI) ctx.ui.setStatus('command-guard', undefined);

    try {
      loadPolicy(policyPath);
    } catch (error) {
      if (!ctx.hasUI) return;

      const message =
        error instanceof PolicyError
          ? error.message
          : 'Command guard configuration error';
      ctx.ui.notify(message, 'error');
    }
  });
}

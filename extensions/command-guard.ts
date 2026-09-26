import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCommand } from "./command-guard/commands.ts";
import { matches } from "./command-guard/match.ts";
import { canonicalPath, inputPaths } from "./command-guard/paths.ts";
import {
  loadPolicy,
  loadShared,
  PolicyError,
  visible,
  type GuardTool,
  type Rule,
} from "./command-guard/policy.ts";

const APPROVAL_TIMEOUT_MS = 120_000;

const home = homedir();

// Resolve the entrypoint first: Pi may load it through a legacy symlink.
const extensionPath = canonicalPath(fileURLToPath(import.meta.url));
const extensionDir = dirname(extensionPath);
const policyPath = join(extensionDir, "../command-guard.json");
const sharedPath = join(extensionDir, "../dangerous-patterns.txt");

const legacyFiles = [
  join(home, ".pi/agent/extensions/command-guard.ts"),
];

// Helper modules are protected by directory, so a new one needs no entry here.
const protectedDirs = [
  join(extensionDir, "command-guard"),
  join(home, ".pi/agent/extensions/command-guard"),
];

interface GuardOptions {
  sharedPath?: string;
  policyPath?: string;
  homeDir?: string;
}

interface Invocation {
  tool: GuardTool;
  input: Record<string, unknown>;
  // The Bash command, or the file tool's path argument.
  target: string;
  // What rules are matched against: the command as written and its canonical
  // spelling, or every path spelling.
  targets: string[];
}

function supported(tool: string): tool is GuardTool {
  return tool === "bash" || tool === "read" || tool === "edit" || tool === "write";
}

function block(
  reason: string,
  advice = "Do not retry or work around this guard.",
): ToolCallEventResult {
  return { block: true, reason: `${reason} ${advice}` };
}

// The default macOS volume ignores case and treats NFC and NFD alike, so a
// differently spelled path can still open a protected file.
function comparable(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function withCanonical(paths: string[]): string[] {
  return paths.flatMap(path => [path, canonicalPath(path)]).map(comparable);
}

function isGuardOwned(targets: string[], protectedFiles: string[]): boolean {
  const files = withCanonical(protectedFiles);
  const dirs = withCanonical(protectedDirs);

  return targets.map(comparable).some(target =>
    files.includes(target) || dirs.some(dir => target.startsWith(`${dir}/`)));
}

// `cause` names what asked: a policy selector or a command-analysis reason.
function approvalMessage(cause: string, call: Invocation, cwd: string): string {
  const isBash = call.tool === "bash";
  const action = isBash ? call.target : JSON.stringify(call.input, null, 2);

  const lines = [
    cause,
    `Working directory: ${cwd}`,
    ...(isBash ? [] : [`Resolved paths: ${call.targets.join(", ")}`]),
    "",
    action,
    "",
    "Approve this invocation once? No answer within 120 seconds denies it.",
  ];

  return visible(lines.join("\n"));
}

// Returns a block result unless the user approves this exact invocation.
async function requestApproval(
  cause: string,
  call: Invocation,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
  if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") {
    return block("Approval required, but no approval UI is available.");
  }

  // Another extension could rewrite the input while the dialog is open.
  const snapshot = JSON.stringify(call.input);

  try {
    const approved = await ctx.ui.confirm(
      "Command guard — approval required",
      approvalMessage(cause, call, ctx.cwd),
      { signal: ctx.signal, timeout: APPROVAL_TIMEOUT_MS },
    );

    const unchanged = snapshot === JSON.stringify(event.input);
    if (approved !== true || ctx.signal?.aborted || !unchanged) {
      return block("Approval denied, cancelled, expired, or invocation changed.");
    }
  } catch {
    return block("Approval could not be obtained.");
  }

  return undefined;
}

export function createCommandGuard(options: GuardOptions = {}) {
  const shared = options.sharedPath ?? sharedPath;
  const policyFile = options.policyPath ?? policyPath;
  const homeDir = options.homeDir ?? home;

  // Test policy paths are additive: injection cannot remove production protections.
  const protectedFiles = [...new Set([
    sharedPath,
    policyPath,
    shared,
    policyFile,
    extensionPath,
    join(extensionDir, "../package.json"),
    ...legacyFiles,
  ])];

  async function evaluate(
    tool: GuardTool,
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> {
    if (ctx.signal?.aborted) return block("Invocation cancelled.");

    const input: Record<string, unknown> = event.input;
    const target = tool === "bash" ? input.command : input.path;
    if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
      return block("Invalid command-guard tool input.");
    }

    // Bash is judged by its decoded arguments as well as by its text.
    const analysis = tool === "bash" ? analyzeCommand(target, ctx.cwd) : undefined;
    const targets = analysis
      ? [target, analysis.canonical]
      : inputPaths(tool, target, ctx.cwd, homeDir);
    const call: Invocation = { tool, input, target, targets };

    // 1. Built-in protection, before any mutable configuration is consulted.
    const mutates = tool === "edit" || tool === "write";
    if (mutates && isGuardOwned(targets, protectedFiles)) {
      return block("Guard-owned file is protected. Make policy changes manually outside Pi.");
    }

    // 2. Shared regex denies.
    const sharedDenies = tool === "bash" ? loadShared(shared) : [];
    if (sharedDenies.some(regex => targets.some(text => regex.test(text)))) {
      return block(`Denied by shared policy ${visible(shared)}.`);
    }

    // The policy loads before any verdict below, so a broken one blocks even
    // a command that analysis alone would let through.
    const policy = loadPolicy(policyFile);
    const matchesCall = (rule: Rule) => matches(rule, tool, targets, ctx.cwd, homeDir);
    const decisions = analysis?.decisions ?? [];

    // 3. Command-analysis and JSON denies, which no approval can override.
    const refused = decisions.find(decision => decision.verdict === "deny");
    if (refused) {
      return block(`Denied by command guard: ${refused.reason}.`, refused.advice);
    }

    const denied = policy.deny.find(matchesCall);
    if (denied) {
      return block(`Denied by JSON deny selector ${visible(denied.selector)}.`);
    }

    // 4. Command-analysis and JSON asks. 5. Otherwise the call proceeds.
    const questioned = decisions.find(decision => decision.verdict === "ask");
    if (questioned) {
      return requestApproval(`Reason: ${questioned.reason}`, call, event, ctx);
    }

    const asked = policy.ask.find(matchesCall);
    if (!asked) return undefined;

    return requestApproval(`Rule: ${asked.selector}`, call, event, ctx);
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
      return block(error instanceof PolicyError
        ? error.message
        : "Command guard could not evaluate this invocation safely. Check configuration externally.");
    }
  };
}

export default function commandGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", createCommandGuard());

  pi.on("session_start", (_event, ctx) => {
    // Clear status left by older versions without adding persistent footer noise.
    if (ctx.hasUI) ctx.ui.setStatus("command-guard", undefined);

    try {
      loadShared(sharedPath);
      loadPolicy(policyPath);
    } catch (error) {
      if (!ctx.hasUI) return;

      const message = error instanceof PolicyError
        ? error.message
        : "Command guard configuration error";
      ctx.ui.notify(message, "error");
    }
  });
}

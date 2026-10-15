/**
 * The ONLY place that knows how Pi is invoked. If Pi flags change, fix buildPiInvocation().
 *
 * Target: @earendil-works/pi-coding-agent@1.2.0 (see NOTES.md; @mariozechner/pi-coding-agent 0.73.1 is deprecated
 * and cannot load the subagent package). Run as `<node >=22.19> <pi cli.js>`. Flags verified in the 0.73.1 and
 * 0.87.1 tarballs (dist/cli/args.js, dist/main.js, docs/json.md) and by the config agent against 1.2.0 + a mock:
 *  - `--mode json`           non-interactive; session header line then one JSON event per line on stdout.
 *                            Exit code stays 0 even if the model call failed -> status comes from the events.
 *  - `--model openrouter/<id>`  provider-prefixed id (unambiguous: Pi also has built-in anthropic/minimax providers).
 *  - `--session-dir <dir>`   session JSONL outside the workspace (else <agentDir>/sessions).
 *  - extra per-mode args from foreman.config.json (harness modes: --orchestrate, from the Foreman Pi package their
 *    settings.json loads; all modes: --no-skills --no-approve). --orchestrate must not directly precede a
 *    positional message (Pi would read it as the flag's value); here the prompt comes on stdin, so it never does.
 *  - env PI_CODING_AGENT_DIR=<abs pi-config/<mode>> plus config pi.env (PI_OFFLINE=1, PI_TELEMETRY=0).
 *    OPENROUTER_API_KEY is inherited from the runner's environment (the runner loads .env; Pi does not).
 *  - prompt on stdin: when stdin is not a TTY Pi reads it to EOF and uses it as the first message
 *    (main.js readPipedStdin + initial-message.js). Avoids Windows quoting and command-line length limits.
 */
import { capture, resolveExecutable, runProcess, type ProcResult } from "./proc.ts";

export interface PiInvocationInput {
  cli: string;
  node?: string | null;
  agentDir: string; // absolute
  provider: string;
  model: string;
  prompt: string;
  sessionDir: string; // absolute, outside the workspace
  extraArgs?: string[];
  extraEnv?: Record<string, string>;
}

export interface PiInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  shell: boolean;
  /** For logs/meta: never contains secrets. */
  display: string;
  resolvedHow: string;
}

export function piModelRef(provider: string, model: string): string {
  return model.toLowerCase().startsWith(`${provider.toLowerCase()}/`) ? model : `${provider}/${model}`;
}

export function buildPiInvocation(input: PiInvocationInput): PiInvocation {
  const exe = resolveExecutable(input.cli, input.node);
  const piArgs = ["--mode", "json", "--model", piModelRef(input.provider, input.model), ...(input.extraArgs ?? []), "--session-dir", input.sessionDir];
  const env = { ...(input.extraEnv ?? {}), PI_CODING_AGENT_DIR: input.agentDir };
  const envDisplay = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return {
    command: exe.command,
    args: [...exe.prefixArgs, ...piArgs],
    env,
    stdin: input.prompt,
    shell: exe.shell,
    display: `${envDisplay} pi ${piArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")} < SPEC.md`,
    resolvedHow: exe.how,
  };
}

export async function runPi(inv: PiInvocation, cwd: string, eventsFile: string, stderrFile: string, timeoutMs: number): Promise<ProcResult> {
  return runProcess({
    command: inv.command,
    args: inv.args,
    cwd,
    env: { ...process.env, ...inv.env },
    stdinText: inv.stdin,
    stdoutFile: eventsFile,
    stderrFile,
    timeoutMs,
    shell: inv.shell,
  });
}

/** `pi --version` (no model call). */
export function piVersion(cli: string, node: string | null | undefined, cwd: string, agentDir: string): string | null {
  try {
    const exe = resolveExecutable(cli, node);
    const r = capture(exe.command, [...exe.prefixArgs, "--version"], cwd, { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, exe.shell);
    const v = (r.stdout || r.stderr).trim().split(/\r?\n/).pop();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * `pi --help` for a mode's config dir (no model call) and check that extension flags are listed. With PI_OFFLINE=1 a
 * missing package is skipped silently, so this proves e.g. the subagent extension really loads.
 * Note: any Pi start writes auth.json/models-store.json into the agent dir (gitignored by the config owner).
 */
export function piHelpHasFlags(cli: string, node: string | null | undefined, cwd: string, agentDir: string, extraEnv: Record<string, string>, flags: string[]): { ok: boolean; missing: string[]; error?: string } {
  try {
    const exe = resolveExecutable(cli, node);
    const r = capture(exe.command, [...exe.prefixArgs, "--help"], cwd, { ...process.env, ...extraEnv, PI_CODING_AGENT_DIR: agentDir }, exe.shell);
    const text = `${r.stdout}\n${r.stderr}`;
    const missing = flags.filter((f) => !text.includes(f));
    return { ok: missing.length === 0, missing };
  } catch (e) {
    return { ok: false, missing: flags, error: (e as Error).message };
  }
}

/** Node major.minor check for the binary that runs Pi. */
export function nodeVersion(node: string | null | undefined): string | null {
  const r = capture(node || process.execPath, ["--version"], process.cwd());
  return r.status === 0 ? r.stdout.trim() : null;
}

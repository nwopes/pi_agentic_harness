/**
 * Contamination check: did any agent tool call touch the hidden tests, the demo-tasks folder, the Foreman repo,
 * or paths outside its workspace? Heuristic (string/path based) — it flags, it never edits results.
 */
import path from "node:path";
import { isInside } from "./util.ts";
import type { ToolCall } from "./usage.ts";

export interface ContaminationFlag {
  severity: "critical" | "warning";
  kind: "hidden-tests" | "demo-tasks" | "foreman-repo" | "outside-workspace" | "worker-cwd";
  tool: string;
  origin: string;
  detail: string;
}

export interface ContaminationResult {
  scannedToolCalls: number;
  scannedOrigins: string[];
  flags: ContaminationFlag[];
  critical: number;
  warnings: number;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
// System locations agents legitimately touch (shells, null devices, tool installs).
const IGNORED = [/^\/dev\//, /^\/usr\//, /^\/bin\//, /^\/proc\//, /^[a-z]:[\\/]program files/i, /^[a-z]:[\\/]windows[\\/]/i, /^nul$/i];

// Characters that end a path token in a shell command.
const STOP = "\\s\"'`;|&<>()";
const WIN_ABS = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^${STOP}]*`, "g");
// Only filesystem-looking POSIX roots (Git Bash drive mounts /c/..., tmp, home dirs). "/api/habits" is a URL path.
const POSIX_ABS = new RegExp(`(?<![A-Za-z0-9_.~:/-])/(?:[A-Za-z](?=/|$|[${STOP}])|tmp/|home/|Users/|mnt/|root/|var/|opt/|srv/|private/)[^${STOP}]*`, "g");
const HOME_REL = new RegExp(`(?<![A-Za-z0-9_])~/[^${STOP}]*`, "g");
// ".." as a path segment (not the "..." spread operator).
const PARENT_REL = new RegExp(`(?<![A-Za-z0-9_./-])\\.\\.(?=[\\\\/]|$|[${STOP}])(?:[\\\\/][^${STOP}]*)?`, "g");
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

/** Drop heredoc bodies (file contents written via bash) so code like fetch("/api/x") is not read as a path. */
function stripHeredocs(cmd: string): string {
  return cmd.replace(HEREDOC, "<<heredoc");
}

/** Pull absolute-looking and parent-relative paths out of a shell command. */
function pathsInCommand(rawCmd: string): string[] {
  const cmd = stripHeredocs(rawCmd);
  const out: string[] = [];
  for (const re of [WIN_ABS, POSIX_ABS, HOME_REL, PARENT_REL]) for (const m of cmd.matchAll(re)) out.push(m[0]);
  return out;
}

function msysToWin(p: string): string {
  // /c/Users/x -> C:/Users/x (Git Bash style)
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m && process.platform === "win32" ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : p;
}

export function checkToolCalls(
  calls: ToolCall[],
  ctx: { workspace: string; repoRoot: string; taskDir?: string; homeDir?: string },
): ContaminationResult {
  const flags: ContaminationFlag[] = [];
  const add = (f: ContaminationFlag) => {
    if (!flags.some((x) => x.kind === f.kind && x.detail === f.detail && x.origin === f.origin)) flags.push(f);
  };
  const classify = (raw: string, call: ToolCall, cwd: string) => {
    let s = raw.trim().replace(/[),]+$/, "");
    if (!s || IGNORED.some((re) => re.test(s))) return;
    if (s.startsWith("~/") && ctx.homeDir) s = path.join(ctx.homeDir, s.slice(2));
    s = msysToWin(s);
    if (s.startsWith("/") && process.platform === "win32") {
      // POSIX-only absolute path on Windows (e.g. /tmp): outside the workspace, low risk.
      add({ severity: "warning", kind: "outside-workspace", tool: call.name, origin: call.origin, detail: raw });
      return;
    }
    const abs = path.resolve(cwd, s);
    if (isInside(abs, ctx.workspace)) return;
    if (isInside(abs, ctx.repoRoot) || (ctx.taskDir && isInside(abs, ctx.taskDir))) {
      add({ severity: "critical", kind: "foreman-repo", tool: call.name, origin: call.origin, detail: raw });
      return;
    }
    add({ severity: "warning", kind: "outside-workspace", tool: call.name, origin: call.origin, detail: raw });
  };

  for (const call of calls) {
    let argsText = "";
    try {
      argsText = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
    } catch {
      argsText = String(call.args);
    }
    const lower = argsText.toLowerCase();
    if (/hidden[-_]tests?/.test(lower)) add({ severity: "critical", kind: "hidden-tests", tool: call.name, origin: call.origin, detail: snippet(argsText, /hidden[-_]tests?/i) });
    if (lower.includes("demo-tasks")) add({ severity: "critical", kind: "demo-tasks", tool: call.name, origin: call.origin, detail: snippet(argsText, /demo-tasks/i) });

    const args = call.args && typeof call.args === "object" ? call.args : {};
    if (PATH_TOOLS.has(call.name) && typeof args.path === "string") classify(args.path, call, ctx.workspace);
    if (call.name === "bash" && typeof args.command === "string") for (const p of pathsInCommand(args.command)) classify(p, call, ctx.workspace);
    // Delegation calls may set a cwd for workers (e.g. @mjakl/pi-subagent `calls[].cwd`).
    const items = Array.isArray(args.calls) ? args.calls : Array.isArray(args.tasks) ? args.tasks : [];
    for (const c of items) if (typeof c?.cwd === "string") classify(c.cwd, call, ctx.workspace);
  }
  const critical = flags.filter((f) => f.severity === "critical").length;
  return {
    scannedToolCalls: calls.length,
    scannedOrigins: [...new Set(calls.map((c) => c.origin))],
    flags,
    critical,
    warnings: flags.length - critical,
  };
}

function snippet(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return text.slice(0, 120);
  const start = Math.max(0, m.index - 50);
  return text.slice(start, m.index + 70);
}

/** Exported for the self-test. */
export const _internal = { pathsInCommand, stripHeredocs };

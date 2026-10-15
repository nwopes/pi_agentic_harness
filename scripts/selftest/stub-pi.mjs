#!/usr/bin/env node
// Stub "pi" for the zero-spend self-test. Mimics what the runner relies on from `pi --mode json` (Pi 1.2.0 +
// @mjakl/pi-subagent): session header + JSONL events on stdout, assistant message_end usage, tool_execution_*,
// the `subagent` tool result details, a session file under --session-dir, files written into the workspace.
// It also CHECKS the invocation shape from foreman.config.json (flags + env) and exits 64 if it is wrong.
// Behaviour is keyed off the workspace folder name (<mode>-<n>) and STUB_FAIL so runs exercise different paths.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
// A harness profile loads the Foreman package through settings.json "packages" (pi-config/harness/settings.json).
const settings = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  } catch {
    return {};
  }
})();
const isHarness = Array.isArray(settings.packages) && settings.packages.length > 0;
if (argv.includes("--version")) {
  console.log(process.env.STUB_VERSION ?? "0.0.0-stub");
  process.exit(0);
}
if (argv.includes("--help")) {
  console.log("pi (stub)\n  --mode <mode>\n  --model <id>\n" + (isHarness ? "Extension CLI Flags:\n  --orchestrate\n  --subagent-max-depth <value>\n" : ""));
  process.exit(0);
}
const orchestrate = argv.includes("--orchestrate");
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const modelRef = flag("--model") ?? "unknown";
const provider = modelRef.includes("/") ? modelRef.split("/")[0] : "openrouter";
const model = modelRef.startsWith("openrouter/") ? modelRef.slice("openrouter/".length) : modelRef;
const sessionDir = flag("--session-dir");
const cwd = process.cwd();
const runId = path.basename(cwd);

// ---- invocation-shape checks (mirror NOTES.md "Headless JSON-event run")
const problems = [];
if (flag("--mode") !== "json") problems.push("--mode json missing");
if (!modelRef.startsWith("openrouter/")) problems.push(`--model must be openrouter/<id>, got ${modelRef}`);
for (const f of ["--no-skills", "--no-approve"]) if (!argv.includes(f)) problems.push(`${f} missing`);
if (!sessionDir || !path.isAbsolute(sessionDir)) problems.push("--session-dir <abs> missing");
if (process.env.PI_OFFLINE !== "1" || process.env.PI_TELEMETRY !== "0") problems.push("PI_OFFLINE=1 / PI_TELEMETRY=0 not set");
// The Foreman package replaces the old hand-built harness flags: lead prompt, depth cap and worker sync all come
// from --orchestrate.
if (argv.includes("--append-system-prompt") || argv.includes("--subagent-max-depth")) problems.push("old harness flags (--append-system-prompt/--subagent-max-depth) instead of the Foreman package");
if (isHarness && !orchestrate) problems.push("harness mode without --orchestrate");
if (!isHarness && orchestrate) problems.push("--orchestrate in a profile that does not load the Foreman package");
if (problems.length) {
  process.stderr.write(`stub-pi: bad invocation: ${problems.join("; ")}\n`);
  process.exit(64);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const sessionId = randomUUID();
const now = () => Date.now();
let last;
const emit = (ev) => {
  process.stdout.write(JSON.stringify(ev) + "\n");
  last = ev;
};
const usage = (input, output, cacheRead, cacheWrite) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
});
const assistant = (content, u, stopReason, extra = {}) => ({ role: "assistant", content, api: "openai-completions", provider, model, responseId: `gen-${randomUUID()}`, usage: u, stopReason, timestamp: now(), ...extra });
let tc = 0;
const tool = (name, args, run) => {
  const id = `call_${++tc}`;
  emit({ type: "message_end", message: assistant([{ type: "toolCall", id, name, arguments: args }], usage(1500, 200, 4000, 600), "toolUse") });
  emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
  const result = run ? run() : { content: [{ type: "text", text: "ok" }], details: {} };
  emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: false, durationMs: 5 });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: name, content: result.content, details: result.details, isError: false, usage: null, timestamp: now() } });
  return id;
};
const finish = () => {
  emit({ type: "turn_end", message: last.message, toolResults: [] });
  emit({ type: "agent_end", messages: [], willRetry: false });
  emit({ type: "agent_settled" });
  if (sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + "\n");
  }
  process.exit(0);
};

if (isHarness && runId.endsWith("-2")) process.stderr.write(`Warning: Model "${model}" not found for provider "${provider}". Using custom model id.\n`);

emit({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd });
emit({ type: "agent_start" });
emit({ type: "turn_start" });
// Like real Pi + Foreman: the system message declares the active tools (subagent only in lead mode), and
// foreman/prompt.ts records each application of the lead prompt as a session entry. STUB_FAIL=nolead drops it.
const toolsAdded = ["read", "bash", "edit", "write", ...(orchestrate ? ["subagent"] : [])].map((name) => ({ name, description: `${name} (stub)` }));
emit({ type: "message_end", message: { role: "system", content: "stub system prompt", sections: { preamble: "stub" }, toolsAdded, timestamp: now() } });
if (orchestrate && process.env.STUB_FAIL !== "nolead") {
  emit({ type: "entry_appended", entry: { type: "custom", customType: "foreman-lead-applied", data: { leadSha256: "stub" }, id: "e1", timestamp: new Date().toISOString() } });
}
emit({ type: "message_end", message: { role: "user", content: prompt.trim(), timestamp: now() } });

if (process.env.STUB_FAIL === "billing") {
  // NOTES.md live log: OpenRouter 402 ends the run in seconds, exit code 0, error only in the assistant message.
  emit({
    type: "message_end",
    message: assistant([], usage(0, 0, 0, 0), "error", {
      errorMessage: '402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 23656.","code":402,"metadata":{"limit_source":"openrouter_credits"}},"type":"billing_error"}',
    }),
  });
  finish();
}

// A delta-only message_update with usage (Pi 1.2) must NOT be counted.
emit({ type: "message_update", usage: usage(999999, 999999, 0, 0), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Pla" } });

tool("write", { path: "BOARD.md", content: "# Board\n" }, () => {
  fs.writeFileSync(path.join(cwd, "BOARD.md"), "# Board\n\n| id | owner | status |\n|---|---|---|\n| T1 | backend | done |\n");
  return { content: [{ type: "text", text: "wrote BOARD.md" }], details: {} };
});

if (runId === "strong-solo-2") {
  // Hang with a grandchild process: exercises the wall-clock timeout and the process-tree kill.
  const gc = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
  if (process.env.STUB_PID_FILE) fs.writeFileSync(process.env.STUB_PID_FILE, String(gc.pid));
  emit({ type: "tool_execution_start", toolCallId: "call_hang", toolName: "bash", args: { command: "npm run dev" } });
  setInterval(() => {}, 1000);
} else {
  if (isHarness) {
    // The Foreman package ships its workers (<package>/foreman/agents in this repo, <package>/agents in the
    // self-test's scratch package); settings.json "packages" paths are relative to the agent dir.
    const pkg = path.resolve(agentDir, settings.packages[0]);
    const workersDir = [path.join(pkg, "foreman", "agents"), path.join(pkg, "agents")].find((d) => fs.existsSync(d));
    if (!workersDir) {
      process.stderr.write(`stub-pi: no worker definitions under ${pkg}\n`);
      process.exit(64);
    }
    const workers = fs
      .readdirSync(workersDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const text = fs.readFileSync(path.join(workersDir, f), "utf8");
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
        const get = (k) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim();
        return { agent: get("name") ?? f.replace(/\.md$/, ""), model: get("model") };
      });
    if (runId.endsWith("-1")) {
      // @mjakl/pi-subagent shape: tool "subagent", details.kind "pi-subagent", per-message usage in results[].messages.
      const id = `call_${++tc}`;
      const args = { calls: workers.map((w) => ({ agent: w.agent, prompt: `do the ${w.agent} part` })) };
      const results = workers.map((w, i) => {
        const served = w.model.replace(/^openrouter\//, "");
        const big = w.agent === "tests"; // one >100k-prompt request: exercises long-context override pricing
        const msgs = [
          assistant([{ type: "toolCall", id: `w${i}_1`, name: "read", arguments: { path: "src/habits.js" } }], usage(big ? 110000 : 8000, 1500, 20000, 0), "toolUse"),
          assistant([{ type: "text", text: "done" }], usage(2000 * (i + 1), 500, 10000, 0), "stop"),
        ].map((m) => ({ ...m, model: served, ...(w.agent === "backend" ? { responseModel: `${served}-served-variant` } : {}) }));
        const sum = (k) => msgs.reduce((a, m) => a + m.usage[k], 0);
        return {
          callIndex: i,
          agent: w.agent,
          agentSource: "user",
          prompt: args.calls[i].prompt,
          initialContext: "empty",
          exitCode: 0,
          messages: msgs,
          stderr: "",
          usage: { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), cost: 0.002, contextTokens: 1234, turns: 2 },
          model: w.model,
          stopReason: "stop",
        };
      });
      emit({ type: "message_end", message: assistant([{ type: "toolCall", id, name: "subagent", arguments: args }], usage(2500, 400, 6000, 0), "toolUse") });
      emit({ type: "tool_execution_start", toolCallId: id, toolName: "subagent", args });
      for (let k = 0; k < 3; k++) emit({ type: "tool_execution_update", toolCallId: id, toolName: "subagent", args, partialResult: { content: [], details: { kind: "pi-subagent", projectAgentsDir: null, results: results.slice(0, 1) } } });
      const details = { kind: "pi-subagent", projectAgentsDir: null, results };
      emit({ type: "tool_execution_end", toolCallId: id, toolName: "subagent", result: { content: [{ type: "text", text: "3/3 succeeded" }], details }, isError: false });
      emit({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: "subagent", content: [{ type: "text", text: "3/3 succeeded" }], details, isError: false, usage: null, timestamp: now() } });
    } else {
      // oira666_pi-subagent durable shape + a per-call model override + worker transcripts saved under the session dir.
      const results = workers.map((w, i) => ({
        agent: w.agent,
        agentSource: "user",
        task: `do part ${i}`,
        name: ["John", "Maria", "Ken"][i % 3],
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: { input: 10000 * (i + 1), output: 2000 * (i + 1), cacheRead: 30000, cacheWrite: 0, cost: 0.002, contextTokens: 0, turns: 3 },
        toolCalls: { write: 2 },
        completedTurns: 3,
        model: w.model,
        subtreeUsageSummary: { subagentCount: 1, inputTokens: 10000 * (i + 1), outputTokens: 2000 * (i + 1), cacheReadTokens: 30000, cacheWriteTokens: 0, costUsd: 0.002, turns: 3 },
      }));
      const details = { schemaVersion: 3, mode: "parallel", delegationMode: "spawn", projectAgentsDir: null, results, usageSummary: { subagentCount: results.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 } };
      const id = `call_${++tc}`;
      const args = { tasks: results.map((r, i) => ({ agent: r.agent, task: r.task, max_subagents_allowed: 0, ...(i === 0 ? { model: "openrouter/anthropic/claude-opus-5.5" } : {}) })) };
      emit({ type: "message_end", message: assistant([{ type: "toolCall", id, name: "subagents", arguments: args }], usage(2500, 400, 6000, 0), "toolUse") });
      emit({ type: "tool_execution_start", toolCallId: id, toolName: "subagents", args });
      emit({ type: "tool_execution_end", toolCallId: id, toolName: "subagents", result: { content: [{ type: "text", text: "3/3 done" }], details }, isError: false });
      emit({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: "subagents", content: [{ type: "text", text: "3/3 done" }], details, isError: false, timestamp: now() } });
      if (sessionDir) {
        results.forEach((r, i) => {
          const d = path.join(sessionDir, "subagents", sessionId, id, String(i));
          fs.mkdirSync(d, { recursive: true });
          const readPath = i === 0 ? "../../demo-tasks/habit-tracker/hidden-tests/api.test.ts" : "src/habits.js";
          const recs = [
            { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd },
            { type: "message", id: "m1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: `w${i}_1`, name: "read", arguments: { path: readPath } }], model: r.model, usage: usage(1, 1, 0, 0), stopReason: "toolUse" } },
          ];
          fs.writeFileSync(path.join(d, "worker.jsonl"), recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
        });
      }
    }
  }
  tool("write", { path: "src/habits.js", content: "export const habits = [];\n" }, () => {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "habits.js"), "export const habits = [];\n");
    fs.writeFileSync(path.join(cwd, ".stub-score"), runId.startsWith("harness") ? (runId.endsWith("-1") ? "18" : "17") : "19");
    return { content: [{ type: "text", text: "ok" }], details: {} };
  });
  const cmd = runId === "strong-solo-1" ? "npm run build && ls .. && cat > src/a.js <<'EOF'\nfetch('/api/habits'); const x = {...y};\nEOF" : "npm run build";
  tool("bash", { command: cmd });
  emit({ type: "message_end", message: assistant([{ type: "text", text: "Done." }], usage(3000, 500, 9000, 0), "stop") });
  finish();
}

#!/usr/bin/env node
// Offline behaviour test for the Foreman package: drives Pi over RPC and checks what Pi actually SENDS to the model
// (system prompt and tool list), captured by a local stand-in for OpenRouter. No request leaves the machine; the
// stand-in answers every model call with HTTP 400, which ends the run right after the request is recorded.
//
//   node foreman/test/rpc-orchestrate-test.mjs <pi-node> <pi-cli>
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [piNode, piCli] = process.argv.slice(2);
if (!piNode || !piCli) {
  console.error("usage: node rpc-orchestrate-test.mjs <pi-node> <pi-cli>");
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- stand-in model endpoint: record system prompt + tool names per request
const requests = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const system = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => b.text ?? "").join("\n")
      : (body.messages ?? []).filter((m) => m.role === "system" || m.role === "developer").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const tools = (body.tools ?? []).map((t) => t.name ?? t.function?.name).filter(Boolean);
    requests.push({ path: req.url, model: body.model, system, tools });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "offline test stand-in" } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

function newAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, packages: [repo] }, null, 2));
  // Route the built-in openrouter provider to the stand-in (Pi docs/models.md: overriding built-in providers).
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: `http://127.0.0.1:${port}/api` } } }));
  return dir;
}

/** Run one Pi RPC session: send `steps` in order; a step is a slash command or a prompt (waits for the run to end). */
function session(steps, { args = [], env = {} } = {}) {
  const agentDir = newAgentDir();
  const child = spawn(piNode, [piCli, "--mode", "rpc", "--model", "openrouter/anthropic/claude-haiku-5.5", "--no-skills", "--no-session", ...args], {
    cwd: agentDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", OPENROUTER_API_KEY: "sk-or-offline-test", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { notes: [], seen: [], stderr: "", exitCode: null, agents: [] };
  let buffer = "";
  let waiting = null;
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  child.stderr.on("data", (d) => (out.stderr += d));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      const msg = JSON.parse(line);
      if (msg.type === "extension_ui_request" && msg.method === "notify") out.notes.push(msg.message);
      if ((msg.type === "agent_settled" || (msg.type === "response" && msg.id?.startsWith("cmd"))) && waiting) {
        const w = waiting;
        waiting = null;
        w();
      }
    }
  });
  return new Promise((resolveSession) => {
    child.on("exit", (code) => {
      out.exitCode = code;
      try { out.agents = readdirSync(join(agentDir, "agents")); } catch {}
      rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      resolveSession(out);
    });
    (async () => {
      for (const [i, step] of steps.entries()) {
        const before = requests.length;
        await new Promise((r) => {
          waiting = r;
          send({ id: `${step.startsWith("/") ? "cmd" : "prompt"}-${i}`, type: "prompt", message: step });
          setTimeout(() => waiting === r && (waiting = null, r()), 20_000);
        });
        if (!step.startsWith("/")) out.seen.push(requests[before] ?? null);
      }
      child.kill();
    })();
  });
}

const hasLead = (r) => !!r?.system.includes("<lead_mode>") && r.system.includes("You are the LEAD");
const hasList = (r) => !!r?.system.includes("## Available Subagents");
const hasTool = (r) => !!r?.tools.includes("subagent");
const describe = (r) => (r ? `lead_mode=${hasLead(r)} agentList=${hasList(r)} subagentTool=${hasTool(r)} tools=[${r.tools.join(",")}]` : "NO REQUEST RECORDED");

const results = [];
const check = (ok, name, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

// 1. default: lead mode off
let s = await session(["hello"]);
check(s.seen[0] && !hasLead(s.seen[0]) && !hasList(s.seen[0]) && !hasTool(s.seen[0]), "no flag: lead mode off (no lead prompt, no agent list, no subagent tool)", describe(s.seen[0]));
check(["backend.md", "frontend.md", "tests.md"].every((f) => s.agents.includes(f)), "workers synced into <agentDir>/agents at session start", s.agents.join(", "));

// 2. /orchestrate toggles on, then off, in one session; /team reports models
s = await session(["/orchestrate", "build it", "/team", "/orchestrate", "again"]);
check(hasLead(s.seen[0]) && hasList(s.seen[0]) && hasTool(s.seen[0]), "/orchestrate -> on: lead prompt + agent list + subagent tool", describe(s.seen[0]));
check(s.seen[1] && !hasLead(s.seen[1]) && !hasList(s.seen[1]) && !hasTool(s.seen[1]), "/orchestrate again -> off: all three gone", describe(s.seen[1]));
const team = s.notes.find((n) => n.startsWith("Foreman team") && /frontend\s+openrouter\/moonshotai\/kimi-k2\.7-code/.test(n));
check(!!team && /lead\s+openrouter\/anthropic\/claude-haiku-5\.5/.test(team) && /backend\s+openrouter\/minimax\/minimax-m3/.test(team) && /tests\s+openrouter\/anthropic\/claude-haiku-5\.5/.test(team), "/team lists lead + worker models", (team ?? s.notes.join(" | ")).replace(/\n/g, " / "));

// 3. --orchestrate flag (headless form) turns it on at startup
s = await session(["build it"], { args: ["--orchestrate"] });
check(hasLead(s.seen[0]) && hasList(s.seen[0]) && hasTool(s.seen[0]), "--orchestrate: on from the start", describe(s.seen[0]));

// 4. inside a worker (pi-subagent sets PI_SUBAGENT_DEPTH; it also forwards --orchestrate): never leads
s = await session(["do the task"], { args: ["--orchestrate"], env: { PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "1" } });
check(s.seen[0] && !hasLead(s.seen[0]) && !hasTool(s.seen[0]) && !/Unknown option/.test(s.stderr), "worker process with forwarded --orchestrate: no lead prompt, no subagent tool, no 'Unknown option'", describe(s.seen[0]));

// 5. depth cap: the lead's agent list reports max depth 1 (workers can't delegate)
s = await session(["x"], { args: ["--orchestrate"] });
check(/max depth 1/.test(s.seen[0]?.system ?? ""), "delegation capped at depth 1 without --subagent-max-depth", (/- Max depth:[^\n]*/.exec(s.seen[0]?.system ?? "") ?? ["(no depth line)"])[0]);

server.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} check(s) failed` : `ALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);

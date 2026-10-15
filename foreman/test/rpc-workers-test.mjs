#!/usr/bin/env node
// Offline end-to-end test of where workers really run: /workers presets (paid, free OpenRouter, FreeLLMAPI) and
// per-worker models, multilevel delegation (free workers using sub-workers), the FreeLLMAPI rules and /freellm.
// Drives Pi over RPC with the Foreman package and extensions/freellmapi loaded. One local server stands in for both
// OpenRouter (/or/...) and FreeLLMAPI (/v1/...) and records every request. It scripts the models: the lead answers
// each prompt with a `subagent` call to the backend worker, and a worker that has the `subagent` tool hands a
// "SUB-TASK" to a tests sub-worker, so real worker and sub-worker Pi processes run and their requests are recorded.
//
//   node foreman/test/rpc-workers-test.mjs <pi-node> <pi-cli>
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [piNode, piCli] = process.argv.slice(2);
if (!piNode || !piCli) {
  console.error("usage: node rpc-workers-test.mjs <pi-node> <pi-cli>");
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionDir = join(repo, "extensions", "freellmapi");
// Fake keys only.
const FREELLM_KEY = "freellmapi-" + randomBytes(24).toString("hex");
const OPENROUTER_KEY = "sk-or-v1-" + randomBytes(32).toString("hex");
const DELEGATION = { calls: [{ agent: "backend", prompt: "Reply with the word hi." }] };
const SUB_DELEGATION = { calls: [{ agent: "tests", prompt: "SUB-TASK: reply with ok." }] };
const PRESET_FREE = { frontend: "cohere/north-mini-code:free", backend: "poolside/laguna-s-2.1:free", tests: "google/gemma-4-31b-it:free" };

// --- stand-in for both providers
const requests = [];
const unmatched = [];
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? (typeof c?.content === "string" ? c.content : "")).join("\n") : "");
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const path = req.url.split("?")[0];
    if (path === "/livez") return send(200, { status: "ok" });
    if (path === "/v1/models") return send(200, { object: "list", data: [{ id: "auto:smart", object: "model", name: "FreeLLMAPI auto:smart", context_length: 128000, available: true }] });
    // Pi's OpenRouter provider speaks Anthropic Messages (/v1/messages) for Anthropic models, chat completions otherwise.
    const anthropic = path.endsWith("/messages");
    if ((!path.endsWith("/chat/completions") && !anthropic) || req.method !== "POST") {
      unmatched.push(`${req.method} ${path}`);
      return send(404, { error: { message: `not found: ${path}` } });
    }

    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const messages = body.messages ?? [];
    const system = anthropic ? textOf(body.system) : messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
    const conversation = messages.filter((m) => m.role !== "system" && m.role !== "developer");
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);
    const firstUser = textOf(conversation.find((m) => m.role === "user")?.content);
    // Pi's Anthropic-format requests end with an extra {role: "system", output_config} entry; it is filtered out above.
    const last = conversation.at(-1);
    const newTurn = last?.role === "user" && !(Array.isArray(last.content) && last.content.some((c) => c?.type === "tool_result"));
    const role = system.includes("You are the LEAD") ? "lead" : (/You are the (\w+) worker/.exec(system)?.[1] ?? "?");
    const sub = firstUser.includes("SUB-TASK");
    requests.push({
      path,
      model: body.model,
      authorization: req.headers.authorization ?? (req.headers["x-api-key"] ? `x-api-key ${req.headers["x-api-key"]}` : ""),
      role: sub ? `${role} (sub-worker)` : role,
      tools,
      sublead: system.includes("<sub_workers>") || system.includes("You run on a free model, so you may hand"),
      website: system.includes("skills/website/SKILL.md"),
      hasToolResult: conversation.some((m) => m.role === "tool" || (Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"))),
    });

    const call = role === "lead" && newTurn ? DELEGATION : role !== "lead" && !sub && newTurn && tools.includes("subagent") ? SUB_DELEGATION : null;
    if (anthropic) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_test_" + randomBytes(4).toString("hex"), type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      if (call) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_" + randomBytes(4).toString("hex"), name: "subagent", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      event("message_stop", {});
      return res.end();
    }
    const id = "chatcmpl-test-" + randomBytes(4).toString("hex");
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const toolCall = call && { index: 0, id: "call_" + randomBytes(4).toString("hex"), type: "function", function: { name: "subagent", arguments: JSON.stringify(call) } };
    if (!body.stream) {
      const message = call ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "done" };
      return send(200, { id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }], usage });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices, ...extra })}\n\n`);
    if (call) {
      chunk([{ index: 0, delta: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
    } else {
      chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
      chunk([{ index: 0, delta: { content: "done" }, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
    }
    chunk([], { usage });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const root = `http://127.0.0.1:${server.address().port}`;

/** `connected: false` leaves out the saved FreeLLMAPI connection; `workers`/`freellm` pre-write those settings. */
function newAgentDir({ connected = true, workers, freellm } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-workers-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, packages: [repo, extensionDir] }, null, 2));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: `${root}/or` } } }));
  if (connected) {
    writeFileSync(
      join(dir, "freellmapi.json"),
      JSON.stringify({ baseUrl: root, apiKey: FREELLM_KEY, models: [{ id: "auto:smart", name: "FreeLLMAPI auto:smart", contextWindow: 128000 }, { id: "auto:fast", name: "FreeLLMAPI auto:fast", contextWindow: 128000 }], savedAt: "test" }),
    );
  }
  if (workers) writeFileSync(join(dir, "foreman-workers.json"), JSON.stringify(workers));
  if (freellm) writeFileSync(join(dir, "freellmapi-mode.json"), JSON.stringify(freellm));
  return dir;
}
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * One Pi RPC session: slash commands wait for their response, prompts wait for agent_settled. `out.steps[i]` holds the
 * requests made during step i. `picks` answer select dialogs in order (first option matching each regex). Pass
 * `agentDir` to reuse one (the caller then removes it).
 */
function session(model, steps, { agentDir: reuse, picks = [] } = {}) {
  const agentDir = reuse ?? newAgentDir();
  const child = spawn(piNode, [piCli, "--mode", "rpc", "--model", model, "--no-skills", "--no-session", "--orchestrate"], {
    cwd: agentDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", OPENROUTER_API_KEY: OPENROUTER_KEY },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { notes: [], statuses: [], steps: [], stderr: "", exitCode: null, timedOut: [], agentDir };
  let buffer = "";
  let waiting = null;
  child.stderr.on("data", (d) => (out.stderr += d));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "extension_ui_request" && msg.method === "notify") out.notes.push(msg.message);
      if (msg.type === "extension_ui_request" && msg.method === "setStatus") out.statuses.push(msg);
      if (msg.type === "extension_ui_request" && msg.method === "select") {
        const pick = picks.shift();
        const value = pick && msg.options.find((o) => pick.test(o));
        child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, ...(value ? { value } : { cancelled: true }) }) + "\n");
      }
      if (waiting && (msg.type === "agent_settled" || (msg.type === "response" && msg.id?.startsWith("cmd")))) {
        const w = waiting;
        waiting = null;
        w();
      }
    }
  });
  return new Promise((resolveSession) => {
    child.on("exit", (code) => {
      out.exitCode = code;
      if (!reuse) rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      resolveSession(out);
    });
    (async () => {
      // Give session_start (which may switch the model) a moment before the first step.
      await new Promise((r) => setTimeout(r, 300));
      for (const [i, step] of steps.entries()) {
        const isCmd = step.startsWith("/");
        const before = requests.length;
        await new Promise((r) => {
          waiting = r;
          child.stdin.write(JSON.stringify({ id: `${isCmd ? "cmd" : "prompt"}-${i}`, type: "prompt", message: step }) + "\n");
          setTimeout(() => waiting === r && (out.timedOut.push(step), (waiting = null), r()), isCmd ? 20_000 : 120_000);
        });
        out.steps.push(requests.slice(before));
      }
      child.kill();
    })();
  });
}

const results = [];
const check = (ok, name, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ")}` : ""}`);
};
const show = (list) =>
  list.length
    ? list.map((r) => `${r.role.padEnd(22)} ${r.path} model=${r.model} tools:${r.tools.includes("subagent") ? "+subagent" : "-subagent"} sublead=${r.sublead}`).join("\n")
    : `(no requests recorded; unmatched paths: ${unmatched.join(", ") || "none"})`;
const PAID_LEAD = "openrouter/anthropic/claude-haiku-5.5";
const onOR = (r) => r.path.startsWith("/or/");
const onFree = (r) => r.path.startsWith("/v1/");
const worker = (r) => r.role === "backend";
const subWorker = (r) => r.role.endsWith("(sub-worker)");
const teamOf = (s) => [...s.notes].reverse().find((n) => n.startsWith("Foreman team")) ?? "";
const PAID_IDS = ["minimax/minimax-m3", "moonshotai/kimi-k2.7-code", "anthropic/claude-haiku-5.5"];
const paidWorkerRequests = (reqs) => reqs.filter((r) => r.role !== "lead" && PAID_IDS.includes(r.model));

// 1. Default (paid preset): workers on their pinned OpenRouter models, and they may NOT delegate.
let s = await session(PAID_LEAD, ["/team", "build it"]);
let step = s.steps[1];
check(/workers: paid/.test(teamOf(s)) && /backend\s+openrouter\/minimax\/minimax-m3/.test(teamOf(s)), "default: /team shows the paid preset", teamOf(s));
check(step.some((r) => worker(r) && onOR(r) && r.model === "minimax/minimax-m3" && r.authorization === `Bearer ${OPENROUTER_KEY}`), "default: the backend worker runs on minimax/minimax-m3 via OpenRouter", show(step));
check(step.filter(worker).length > 0 && step.filter(worker).every((r) => !r.tools.includes("subagent") && !r.sublead) && !step.some(subWorker), "default: paid workers get no subagent tool and spawn no sub-workers", show(step));

// 2. /workers free: free OpenRouter models, and a free worker hands a sub-task to a sub-worker on its own model.
const dir = newAgentDir();
s = await session(PAID_LEAD, ["/workers free", "build it"], { agentDir: dir });
step = s.steps[1];
check(readJson(join(dir, "foreman-workers.json"))?.preset === "free" && /workers: free/.test(teamOf(s)) && new RegExp(`backend\\s+openrouter/${PRESET_FREE.backend.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(teamOf(s)), "/workers free: saved, and /team lists the free models", teamOf(s));
check(step.some((r) => worker(r) && onOR(r) && r.model === PRESET_FREE.backend), `/workers free: the backend worker runs on ${PRESET_FREE.backend}`, show(step));
check(step.some((r) => worker(r) && r.tools.includes("subagent") && r.sublead), "multilevel: the free worker has the subagent tool and the sub-worker instructions", show(step));
check(
  step.some((r) => r.role === "tests (sub-worker)" && r.model === PRESET_FREE.backend && onOR(r)) && step.filter(subWorker).every((r) => !r.tools.includes("subagent")),
  "multilevel: the sub-worker ran on the worker's own free model and can't go deeper (depth 2)",
  show(step),
);
check(paidWorkerRequests(step).length === 0, "multilevel: no worker or sub-worker request used a paid model", show(paidWorkerRequests(step)));

// 3. One worker's model: a free one is accepted, a paid one is refused in the free preset, "default" restores it.
s = await session(PAID_LEAD, [`/workers backend openrouter/${PRESET_FREE.tests}`, "build it", "/workers backend openrouter/minimax/minimax-m3", "/workers backend default", "/team"], { agentDir: dir });
check(s.steps[1].some((r) => worker(r) && r.model === PRESET_FREE.tests), "/workers backend <free model>: the backend worker uses it", show(s.steps[1]));
check(s.notes.some((n) => /minimax\/minimax-m3 isn't free/.test(n)), "/workers backend <paid model> in the free preset is refused", s.notes.join(" | "));
check(new RegExp(`backend\\s+openrouter/${PRESET_FREE.backend.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(teamOf(s)), "/workers backend default: back to the preset's model", teamOf(s));

// 4. /workers depth 1: free workers stop delegating (takes effect for the next worker, no restart).
s = await session(PAID_LEAD, ["/workers depth 1", "build it"], { agentDir: dir });
step = s.steps[1];
check(step.some((r) => worker(r) && r.model === PRESET_FREE.backend) && step.filter(worker).every((r) => !r.tools.includes("subagent")) && !step.some(subWorker), "/workers depth 1: the free worker gets no subagent tool and spawns no sub-workers", show(step));
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// 5. /workers freellm: workers and their sub-workers on FreeLLMAPI; the lead stays on OpenRouter.
s = await session(PAID_LEAD, ["/workers freellm", "build it"]);
step = s.steps[1];
check(
  step.some((r) => worker(r) && onFree(r) && r.model === "auto:smart" && r.authorization === `Bearer ${FREELLM_KEY}`) && step.some((r) => subWorker(r) && onFree(r) && r.model === "auto:smart"),
  "/workers freellm: worker and sub-worker run on FreeLLMAPI auto:smart with the FreeLLMAPI key",
  show(step),
);
check(step.filter((r) => r.role !== "lead").every(onFree) && step.filter((r) => r.role === "lead").every(onOR), "/workers freellm: only the lead's requests go to OpenRouter", show(step));

// 6. Lead on FreeLLMAPI with the paid preset: workers follow the lead; nothing reaches OpenRouter.
s = await session("freellmapi/auto:smart", ["/team", "build it"]);
step = s.steps[1];
check(step.length > 0 && !step.some(onOR) && step.some((r) => worker(r) && onFree(r) && r.model === "auto:smart"), "FreeLLMAPI lead + paid preset: workers follow the lead, zero OpenRouter requests", show(step));
check(/backend\s+freellmapi\/auto:smart[^\n]*follows your FreeLLMAPI lead/.test(teamOf(s)) && /OpenRouter key: not used by this team/.test(teamOf(s)), "FreeLLMAPI lead: /team says the workers follow it and OpenRouter isn't used", teamOf(s));

// 7. FreeLLMAPI not connected: /workers freellm is refused; a saved freellm preset blocks delegation (never paid).
const offline = newAgentDir({ connected: false, workers: { preset: "freellm", models: {}, depth: 2 } });
s = await session(PAID_LEAD, ["/workers freellm", "build it"], { agentDir: offline });
check(s.notes.some((n) => /FreeLLMAPI isn't connected\. Run \/login-with-freellm first/.test(n)), "not connected: /workers freellm is refused", s.notes.join(" | "));
check(
  !s.steps[1].some((r) => r.role !== "lead") && s.notes.some((n) => /Workers can't start: .*FreeLLMAPI isn't connected/.test(n)) && s.steps[1].some((r) => r.role === "lead" && r.hasToolResult),
  "not connected: delegation is blocked (no worker request anywhere) and the lead is told why",
  `${s.notes.join(" | ")}\n${show(s.steps[1])}`,
);
rmSync(offline, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// 8. Pickers: plain /workers -> preset, then -> change one worker's model.
const picked = newAgentDir();
s = await session(PAID_LEAD, ["/workers", "/workers"], { agentDir: picked, picks: [/^free:/, /^Change one worker's model/, /^frontend$/, /gemma-4-31b-it:free$/] });
const saved = readJson(join(picked, "foreman-workers.json"));
check(saved?.preset === "free" && saved?.models?.free?.frontend === `openrouter/${PRESET_FREE.tests}`, "pickers: plain /workers chooses the preset, then one worker's model", JSON.stringify(saved));
rmSync(picked, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// 9. /freellm all moves the lead (and so its paid-preset workers) to FreeLLMAPI; off brings the paid lead back.
const free = newAgentDir();
s = await session(PAID_LEAD, ["/freellm all", "build it", "/freellm off", "build it", "/freellm workers"], { agentDir: free });
check(s.steps[1].length > 0 && !s.steps[1].some(onOR) && s.steps[1].some((r) => r.role === "lead" && onFree(r)), "/freellm all: lead and workers on FreeLLMAPI, zero OpenRouter requests", show(s.steps[1]));
check(s.steps[3].some((r) => r.role === "lead" && onOR(r)) && s.steps[3].some((r) => worker(r) && r.model === "minimax/minimax-m3"), "/freellm off: the paid lead and paid workers are back", show(s.steps[3]));
check(s.notes.some((n) => /Worker models are chosen with \/workers now/.test(n)), "/freellm workers points to /workers", s.notes.join(" | "));
check(JSON.stringify(s.statuses).includes("FreeLLMAPI: everything (auto:smart)"), "/freellm all: the footer shows free-only mode", JSON.stringify(s.statuses));
rmSync(free, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// 10. Saved /freellm all: Pi starts on FreeLLMAPI even when launched with a paid model.
const allDir = newAgentDir({ freellm: { mode: "all", model: "auto:smart" } });
s = await session(PAID_LEAD, ["build it"], { agentDir: allDir });
check(s.notes.some((n) => n.startsWith("Free-only mode (/freellm all): using freellmapi/auto:smart")) && s.steps[0].length > 0 && !s.steps[0].some(onOR), "saved /freellm all: the session starts on FreeLLMAPI, nothing reaches OpenRouter", `${s.notes.join(" | ")}\n${show(s.steps[0])}`);
rmSync(allDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

server.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} check(s) failed` : `ALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Offline end-to-end test: while the lead is on a FreeLLMAPI model, Foreman's workers must run on FreeLLMAPI too and
// nothing may reach OpenRouter. Drives Pi over RPC with the Foreman package and this extension loaded; one local
// server stands in for both FreeLLMAPI (/v1/...) and OpenRouter (/or/...) and records every request. The lead's first
// model call answers with a `subagent` tool call, so a real worker Pi process is spawned and its request recorded.
// A control run with the lead on OpenRouter shows the test does see a worker request that goes to OpenRouter.
//
//   node extensions/freellmapi/test/rpc-workers-test.mjs <pi-node> <pi-cli>
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [piNode, piCli] = process.argv.slice(2);
if (!piNode || !piCli) {
  console.error("usage: node rpc-workers-test.mjs <pi-node> <pi-cli>");
  process.exit(2);
}
const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(extensionDir, "..", "..");
// Fake keys: if the OpenRouter one ever shows up at /or/, that is the leak this test exists to catch.
const FREELLM_KEY = "freellmapi-" + randomBytes(24).toString("hex");
const OPENROUTER_KEY = "sk-or-v1-" + randomBytes(32).toString("hex");
const DELEGATION = { calls: [{ agent: "backend", prompt: "Reply with the word hi." }] };

// --- stand-in for both providers
const requests = [];
const unmatched = []; // paths the stand-in does not serve, shown on failure
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("\n") : "");
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
    const system = anthropic
      ? textOf(body.system)
      : messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
    const hasToolResult = anthropic
      ? messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"))
      : messages.some((m) => m.role === "tool");
    requests.push({
      path,
      model: body.model,
      authorization: req.headers.authorization ?? (req.headers["x-api-key"] ? `x-api-key ${req.headers["x-api-key"]}` : ""),
      system,
      tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean),
      hasToolResult,
    });

    const delegate = system.includes("You are the LEAD") && !hasToolResult;
    if (anthropic) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", {
        message: { id: "msg_test_" + randomBytes(4).toString("hex"), type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
      });
      if (delegate) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_" + randomBytes(4).toString("hex"), name: "subagent", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(DELEGATION) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: delegate ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      event("message_stop", {});
      return res.end();
    }
    const id = "chatcmpl-test-" + randomBytes(4).toString("hex");
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const toolCall = { index: 0, id: "call_" + randomBytes(4).toString("hex"), type: "function", function: { name: "subagent", arguments: JSON.stringify(DELEGATION) } };
    if (!body.stream) {
      const message = delegate ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "done" };
      return send(200, { id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message, finish_reason: delegate ? "tool_calls" : "stop" }], usage });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices, ...extra })}\n\n`);
    if (delegate) {
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

function newAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "freellm-workers-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, packages: [repo, extensionDir] }, null, 2));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: `${root}/or` } } }));
  writeFileSync(
    join(dir, "freellmapi.json"),
    JSON.stringify({ baseUrl: root, apiKey: FREELLM_KEY, models: [{ id: "auto:smart", name: "FreeLLMAPI auto:smart", contextWindow: 128000 }], savedAt: "test" }),
  );
  return dir;
}

/** One Pi RPC session: slash commands wait for their response, prompts wait for agent_settled. */
function session(model, steps) {
  const agentDir = newAgentDir();
  const child = spawn(piNode, [piCli, "--mode", "rpc", "--model", model, "--no-skills", "--no-session", "--orchestrate"], {
    cwd: agentDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", OPENROUTER_API_KEY: OPENROUTER_KEY },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { notes: [], stderr: "", exitCode: null, timedOut: [] };
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
      rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      resolveSession(out);
    });
    (async () => {
      for (const [i, step] of steps.entries()) {
        const isCmd = step.startsWith("/");
        await new Promise((r) => {
          waiting = r;
          child.stdin.write(JSON.stringify({ id: `${isCmd ? "cmd" : "prompt"}-${i}`, type: "prompt", message: step }) + "\n");
          setTimeout(() => waiting === r && (out.timedOut.push(step), (waiting = null), r()), isCmd ? 20_000 : 90_000);
        });
      }
      child.kill();
    })();
  });
}

const results = [];
const check = (ok, name, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
};
const show = (list) =>
  list.length
    ? list.map((r) => `${r.path} model=${r.model} auth=${r.authorization.slice(0, 18)}… toolResult=${r.hasToolResult} system="${r.system.slice(0, 80).replace(/\n/g, " ")}"`).join("\n")
    : `(no requests recorded; unmatched paths: ${unmatched.join(", ") || "none"})`;
const isWorker = (r) => r.system.includes("You are the backend worker");

// 1. Lead on FreeLLMAPI: the worker runs on FreeLLMAPI, nothing reaches OpenRouter, /team says so.
let start = requests.length;
let s = await session("freellmapi/auto:smart", ["/team", "build it"]);
let seen = requests.slice(start);
const freeWorker = seen.find((r) => isWorker(r) && r.path === "/v1/chat/completions");
check(
  !!freeWorker && freeWorker.model === "auto:smart" && freeWorker.authorization === `Bearer ${FREELLM_KEY}`,
  "lead on FreeLLMAPI: the backend worker's request went to FreeLLMAPI as auto:smart with the FreeLLMAPI key",
  show(seen) + (s.timedOut.length ? `\ntimed out waiting for: ${s.timedOut.join(", ")}` : "") + (freeWorker ? "" : `\nstderr tail: ${s.stderr.slice(-600)}`),
);
const leaked = seen.filter((r) => r.path.startsWith("/or/"));
check(leaked.length === 0, "lead on FreeLLMAPI: zero requests reached OpenRouter", show(leaked));
check(
  seen.some((r) => r.system.includes("You are the LEAD") && r.hasToolResult),
  "lead on FreeLLMAPI: the worker's result came back to the lead",
  show(seen.filter((r) => !isWorker(r))),
);
let team = s.notes.find((n) => n.startsWith("Foreman team"));
check(
  !!team && /backend\s+freellmapi\/auto:smart\s+\(FreeLLMAPI[^\n]*openrouter\/minimax\/minimax-m3/.test(team),
  "lead on FreeLLMAPI: /team shows the backend on freellmapi/auto:smart, redirected by FreeLLMAPI",
  team ?? s.notes.join(" | "),
);
check(s.notes.some((n) => /Workers run on freellmapi\/auto:smart too/.test(n)), "lead on FreeLLMAPI: the user is told once that workers stay on FreeLLMAPI", s.notes.join(" | "));

// 2. Control, lead on OpenRouter: the worker goes to OpenRouter on its pinned model, so the test can see a leak.
start = requests.length;
s = await session("openrouter/anthropic/claude-haiku-5.5", ["/team", "build it"]);
seen = requests.slice(start);
const orWorker = seen.find((r) => isWorker(r) && r.path.startsWith("/or/"));
check(
  !!orWorker && orWorker.model === "minimax/minimax-m3" && orWorker.authorization === `Bearer ${OPENROUTER_KEY}`,
  "control, lead on OpenRouter: the backend worker's request went to OpenRouter as minimax/minimax-m3",
  show(seen) + (s.timedOut.length ? `\ntimed out waiting for: ${s.timedOut.join(", ")}` : "") + (orWorker ? "" : `\nstderr tail: ${s.stderr.slice(-600)}`),
);
check(!seen.some((r) => r.path.startsWith("/v1/")), "control, lead on OpenRouter: nothing was redirected to FreeLLMAPI", show(seen.filter((r) => r.path.startsWith("/v1/"))));
team = s.notes.find((n) => n.startsWith("Foreman team"));
check(
  !!team && /backend\s+openrouter\/minimax\/minimax-m3/.test(team) && !/freellmapi/.test(team),
  "control, lead on OpenRouter: /team shows the normal OpenRouter worker models",
  team ?? s.notes.join(" | "),
);

server.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} check(s) failed` : `ALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Minimal offline stand-in for a FreeLLMAPI server, for testing the Pi extension without real providers.
// Shapes follow FreeLLMAPI's source (server/src/routes/{auth,settings,client-profiles,proxy,status}.ts).
//
//   node mock-freellmapi.mjs [port]        default port 31499
//
// Accounts:  email "me@example.com", password "hunter22"
// Keys:      unified "freellmapi-" + 48 hex chars (printed at startup), or the client-profile key it creates.
import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.argv[2] ?? 31499);
const EMAIL = "me@example.com";
const PASSWORD = "hunter22";
const UNIFIED_KEY = "freellmapi-" + "ab".repeat(24);
const sessions = new Set();
const profileKeys = new Map(); // key -> profile
let nextProfile = 1;

const MODELS = [
  { id: "auto", name: "Auto", context_length: 131072 },
  { id: "auto:coding", name: "Auto (coding profile)", context_length: 131072 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context_length: 1048576 },
  { id: "llama-3.3-70b", name: "Llama 3.3 70B (Groq)", context_length: 8192 },
];

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function bearer(req) {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-api-key"] ?? null);
}
function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
  });
}
const mask = (k) => (k ? `${String(k).slice(0, 14)}…` : "-");

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const body = req.method === "POST" ? await readJson(req) : undefined;
    console.log(`${req.method} ${url.pathname}${url.search} auth=${mask(bearer(req))}${body?.model ? ` model=${body.model}` : ""}`);

    if (url.pathname === "/livez") return send(res, 200, { status: "ok", version: "mock", uptime_s: 1 });
    if (url.pathname === "/api/ping") return send(res, 200, { status: "ok", timestamp: Date.now() });

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      if (!body || typeof body.email !== "string" || typeof body.password !== "string") return send(res, 400, { error: "email and password are required" });
      if (body.email !== EMAIL || body.password !== PASSWORD) return send(res, 401, { error: "Invalid email or password" });
      const token = crypto.randomBytes(16).toString("hex");
      sessions.add(token);
      return send(res, 200, { token, email: EMAIL });
    }
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/auth/status") {
      if (!sessions.has(bearer(req))) return send(res, 401, { error: "Authentication required" });
      if (url.pathname === "/api/auth/logout" && req.method === "POST") { sessions.delete(bearer(req)); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/settings/api-key" && req.method === "GET") return send(res, 200, { apiKey: UNIFIED_KEY });
      if (url.pathname === "/api/client-profiles" && req.method === "POST") {
        const id = String(nextProfile++);
        const key = "sk-cp-" + crypto.randomBytes(16).toString("hex");
        const profile = { id, name: body?.name ?? "client", maskedKey: mask(key), systemPrompt: null, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), key };
        profileKeys.set(key, profile);
        return send(res, 201, profile);
      }
      return send(res, 404, { error: "not found" });
    }
    if (url.pathname === "/api/auth/status") return send(res, 200, { needsSetup: false, authenticated: false, email: null });

    if (url.pathname.startsWith("/v1/")) {
      const key = bearer(req);
      if (key !== UNIFIED_KEY && !profileKeys.has(key)) return send(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
      if (url.pathname === "/v1/models") {
        return send(res, 200, {
          object: "list",
          data: MODELS.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "freellmapi", name: m.name, context_window: m.context_length, context_length: m.context_length, available: true, unavailable_reason: null })),
        });
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const text = `Hello from mock FreeLLMAPI (model=${body?.model})`;
        const id = "chatcmpl-mock-" + crypto.randomBytes(4).toString("hex");
        const usage = { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 };
        if (!body?.stream) {
          return send(res, 200, { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body?.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const chunk = (delta, finish = null, extra = {}) =>
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body?.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
        chunk({ role: "assistant", content: "" });
        chunk({ content: text });
        chunk({}, "stop");
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body?.model, choices: [], usage })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return send(res, 404, { error: { message: "not found" } });
    }
    send(res, 404, { error: "not found" });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`mock FreeLLMAPI on http://127.0.0.1:${port}  login ${EMAIL} / ${PASSWORD}  unified key ${UNIFIED_KEY}`);
  });

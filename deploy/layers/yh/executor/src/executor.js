"use strict";

const { createServer } = require("node:http");

const EGRESS_URL = process.env.EGRESS_PROXY_URL ?? "http://egress-proxy:48080";
const MODEL_ENDPOINT = process.env.MODEL_ENDPOINT ?? "https://api.deepseek.com/v1/chat/completions";
const MODEL_NAME = process.env.MODEL_NAME ?? "deepseek-chat";
const TOKEN_FILE = process.env.EGRESS_TOKEN_FILE ?? "/run/remote-turn/token/token";

function readToken() {
  try {
    return require("node:fs").readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_RUNTIME_MS = 60_000;

function usageFromBody(body) {
  const usage = body?.usage;
  if (usage && typeof usage === "object") {
    return {
      inputTokens: Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0,
      outputTokens: Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : 0,
    };
  }
  return null;
}

function estimateCost(inputTokens, outputTokens) {
  return (inputTokens / 1_000_000) * 0.27 + (outputTokens / 1_000_000) * 1.1;
}

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/execute") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad_request" }));
    return;
  }
  const text = typeof input.text === "string" ? input.text : "";
  const history = Array.isArray(input.history) ? input.history : [];
  if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad_request", message: "input out of bounds" }));
    return;
  }
  const token = readToken();
  if (!token) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no_egress_token" }));
    return;
  }
  const messages = [];
  for (const item of history.slice(-8)) {
    const role = item.role === "assistant" ? "assistant" : "user";
    if (typeof item.text === "string") messages.push({ role, content: item.text });
  }
  messages.push({ role: "user", content: text });

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_RUNTIME_MS);
  try {
    const authRes = await fetch(`${EGRESS_URL}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, url: MODEL_ENDPOINT }),
    });
    const authBody = await authRes.json();
    if (!authBody.allowed) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "egress_denied", reason: authBody.reason }));
      return;
    }
    const modelRes = await fetch(MODEL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: MODEL_NAME, messages }),
      signal: controller.signal,
    });
    if (!modelRes.ok) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model_error", status: modelRes.status }));
      return;
    }
    const modelBody = await modelRes.json();
    const reply = modelBody?.choices?.[0]?.message?.content ?? "";
    if (!reply || Buffer.byteLength(reply, "utf8") > MAX_OUTPUT_BYTES) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "reply_out_of_bounds" }));
      return;
    }
    const usage = usageFromBody(modelBody);
    const inputTokens = usage?.inputTokens ?? Math.ceil(Buffer.byteLength(text, "utf8") / 4);
    const outputTokens = usage?.outputTokens ?? Math.ceil(Buffer.byteLength(reply, "utf8") / 4);
    await fetch(`${EGRESS_URL}/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        url: MODEL_ENDPOINT,
        usage: { inputTokens, outputTokens, costUsd: estimateCost(inputTokens, outputTokens) },
      }),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reply, runtimeMs: Date.now() - startedAt }));
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model_unreachable" }));
  } finally {
    clearTimeout(timer);
  }
}).listen(8080, () => {
  console.log("[executor] listening on :8080");
});

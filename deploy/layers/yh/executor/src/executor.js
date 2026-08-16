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
    const forwardRes = await fetch(`${EGRESS_URL}/forward`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        url: MODEL_ENDPOINT,
        headers: { "content-type": "application/json" },
        payload: { model: MODEL_NAME, messages },
      }),
      signal: controller.signal,
    });
    const forwardBody = await forwardRes.json();
    if (!forwardBody.body || forwardBody.body.error) {
      const reason = forwardBody.reason ?? forwardBody.body?.error ?? "forward failed";
      res.writeHead(forwardRes.status === 200 ? 502 : forwardRes.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: reason }));
      return;
    }
    const reply = forwardBody.body.choices?.[0]?.message?.content ?? "";
    if (!reply || Buffer.byteLength(reply, "utf8") > MAX_OUTPUT_BYTES) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "reply_out_of_bounds" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reply, runtimeMs: Date.now() - startedAt }));
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "egress_unreachable" }));
  } finally {
    clearTimeout(timer);
  }
}).listen(8080, () => {
  console.log("[executor] listening on :8080");
});

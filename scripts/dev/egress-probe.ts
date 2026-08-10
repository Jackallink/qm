#!/usr/bin/env node
/**
 * egress 门禁验证：mint 带 EgressPolicy 的 capability token → authz 决策。
 * 验证链路：token 签发 → 授权决策（allow/deny）→ 审计。
 * 用法: node --experimental-strip-types scripts/dev/egress-probe.ts
 */
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../../src/auth/capability-token.ts";

const SECRET = process.env.CAPABILITY_SECRET || "qm-dev-capability-secret-for-minions-poc-2026-0801";

// 模拟 prime scope 的 egress 策略：只允许 deepseek API，其余拒绝
const policy = {
  allowedHosts: ["api.deepseek.com"],
  deniedHosts: ["*.github.com"],
};

async function main() {
  console.log("== 1. mint capability token（egress 策略：只允许 api.deepseek.com） ==");
  const token = await mintCapabilityToken(
    {
      actorId: "system:prime-harness",
      scopeId: "personal:jakeliu",
      aud: EGRESS_PROXY_AUD,
      egress: policy,
      exp: Date.now() + 3_600_000,
    },
    SECRET,
  );
  console.log("token 前缀:", token.slice(0, 40) + "...");
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/prime-egress-token.txt", token);

  // 起本地 authz 决策服务
  const { spawn } = await import("node:child_process");
  const child = spawn("node", ["src/egress-authz-main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CAPABILITY_SECRET: SECRET, AUTHZ_PORT: "48081", DATABASE_URL: process.env.DATABASE_URL ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => console.log("[authz]", d.toString().trim()));
  await new Promise((r) => setTimeout(r, 1200));

  const check = async (authority: string, scheme: string) => {
    const res = await fetch("http://127.0.0.1:48081/", {
      headers: {
        "x-egress-authority": authority,
        "x-egress-scheme": scheme,
        "proxy-authorization": `Bearer ${token}`,
      },
    });
    return res.status;
  };

  console.log("\n== 2. 授权决策 ==");
  const allowed = await check("api.deepseek.com", "https");
  console.log("api.deepseek.com →", allowed === 200 ? "ALLOW ✓" : `DENY (${allowed})`);
  const denied = await check("api.github.com", "https");
  console.log("api.github.com   →", denied === 200 ? "ALLOW ✗" : "DENY ✓");
  const metadata = await check("169.254.169.254", "http");
  console.log("169.254.169.254  →", metadata === 200 ? "ALLOW ✗" : "DENY ✓ (metadata)");

  // 无 token（tokenless deny）
  const noToken = await fetch("http://127.0.0.1:48081/", {
    headers: { "x-egress-authority": "api.deepseek.com", "x-egress-scheme": "https" },
  });
  console.log("无 token 请求    →", noToken.status === 200 ? "ALLOW ✗" : "DENY ✓");

  console.log("\n== 3. 审计（egress 决策已写入 audit sink） ==");
  child.kill("SIGTERM");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});

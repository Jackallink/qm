# 验证记录

## 自动化

- `node --test test/custom-providers.test.ts test/custom-provider-route.test.ts test/custom-provider-e2e.test.ts test/pi-harness-freshness.test.ts test/webui-model-allowlist.test.ts test/turn-options.test.ts`
- `npm run typecheck`
- `npm --prefix plugins/web-ui run typecheck`
- `npm --prefix plugins/web-ui test`
- `npm run lint -- --quiet`
- `git diff --check`

本轮结果：上述 core 聚焦命令 70/70 通过；`npm run typecheck`、`npm --prefix plugins/web-ui run typecheck`、`npm run lint -- --quiet` 和 `git diff --check` 均通过；`npm --prefix plugins/web-ui test` 为 502/502 通过。`test/custom-provider-route.test.ts` 以 `pi` harness、无 OpenRouter key 的 fixture 验证：provider 写入后的 custom ID 同时出现在 runtime config 和实际 Web turn 准入中，并拒绝与另一个 custom provider、QM registry 或 Core 管理 provider 模型冲突的 ID。它还覆盖并发 HTTP 写入、endpoint 无新 key 的拒绝、进程 registry 过期后的 durable refresh 与 OpenCode 拒绝。`test/custom-providers.test.ts` 验证旧持久模型冲突记录不会进入 runtime、新 Pi slug 拒绝、DeepSeek alias 的 thinking/tool replay 语义，以及 OpenRouter catalog 失败后仍重建当前 custom registry。`test/custom-provider-e2e.test.ts` 覆盖 fake upstream 的 Pi dispatch。`test/webui-model-allowlist.test.ts` 与 `test/turn-options.test.ts` 保留显式组织模型清单的限制。

后续安全加固：`test/custom-provider-route.test.ts` 以两个独立 loopback origin 证明 Anthropic validation 对 307 返回 `400`，目标 origin 零请求；validation request 显式使用 `redirect: "manual"`。本次聚焦路由测试与 root typecheck 通过。

## 本地真实验证

本地开发实例中，管理员已通过既有 write-only Custom providers 表单保存一个 OpenAI-compatible DeepSeek provider，并将组织默认运行时设为 `Pi + deepseek-v4-flash`。浏览器中的新 Web 对话选择 `DeepSeek V4 Flash` 与 `Pi`，发送最小文本 `Reply with exactly: DEEPSEEK_LIVE_OK` 后，得到 `DEEPSEEK_LIVE_OK`；UI 显示运行约两秒。验证过程未读取、打印或传输 provider API key。

本轮重启后，local dev instance 的 Core、Web 与 Admin 均报告 healthy；运行时为 `Pi`、`turnsLive=true`，session/run store 均为 PostgreSQL。Portal 的 `/healthz` 返回 `{ "ok": true }`。通过 Portal 建立本地会话后，向 Web surface 的 `POST /api/turn` 发送 `Pi + deepseek-v4-flash` 与最小文本 `Reply with exactly: DEEPSEEK_RESTART_OK`，run 在重启后的 Core 上以 `done` 和 `DEEPSEEK_RESTART_OK` 完成，且 `replyComplete=true`。该验证未读取、打印或传输 provider API key。

本地 supervisor status 在重载后仍保留 Portal 的 `crashed` 状态，即使同一 PID 正在监听且 `/healthz` 正常；该观察属于开发监督器状态收敛问题，不改变本功能的 Core 或真实模型验证结论。

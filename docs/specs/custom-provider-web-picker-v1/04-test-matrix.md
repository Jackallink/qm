# 自定义模型 Web 选择器测试矩阵

| AC | 红测试与完成测试 | 位置 |
| --- | --- | --- |
| CPW-01 | `applyRuntimeOptions` 以 Pi、自定义 ID、完整 catalog metadata 构造选项并选择它作为默认值 | `plugins/web-ui/test/model-options.test.ts` |
| CPW-02 | OpenAI-compatible 和 Anthropic-compatible 选项的 `model.id`、`model.name`、`model.provider`、`model.api` 均等于 core catalog 值 | `plugins/web-ui/test/model-options.test.ts` |
| CPW-03 | 既有 OpenRouter、内置和未知 ID 测试继续通过 | `plugins/web-ui/test/model-options.test.ts`、`plugins/web-ui/test/pi-models.test.ts` |
| CPW-04 | provider 写入后，runtime config 对 Pi 暴露不含密钥的 ID/name/provider/API；没有显式 Web 模型清单时，`POST /v1/turns` 接受同一 Pi custom ID；本地 dev instance：Admin provider 状态为 write-only key set，runtime config 为 `pi/deepseek-v4-flash`，新 Web 对话菜单与最小文本 turn 都成功 | `test/custom-provider-route.test.ts`；本地 Firefox/in-app-browser 验证记录 |
| CPW-05 | 另一个 custom provider、QM registry 或 Core 管理 provider ID 的新 provider 写入为 `400`；直接注入的旧冲突记录和 Core 管理 slug 记录不在 runtime catalog 或 key snapshot 中，Web turn 为 `403`；Pi 内置 slug 的新写入为 `400`，但 active legacy `deepseek` 可轮换 key，`deepseek-local/deepseek-v4-flash` 能解析并通过 Pi fake-upstream 路径 | `test/custom-provider-route.test.ts`、`test/custom-providers.test.ts`、`test/custom-provider-e2e.test.ts` |
| CPW-06 | 两个同步 HTTP `PUT` 认领同一 ID 时恰一个 `200`；清空进程 registry 后，下一次 runtime config 与 Web turn 从 durable store 恢复该模型；相同 snapshot 不增加 registry version；OpenRouter catalog refresh 失败也去除旧 custom 项、加入当前项 | `test/custom-provider-route.test.ts`、`test/custom-providers.test.ts`、`test/pi-harness-freshness.test.ts` |
| CPW-07 | custom ID 在 Pi 的 catalog/turn 可用，在 OpenCode catalog 中不可见，`PUT /v1/runtime-config` 选择 `opencode + custom-id` 返回 `model_not_supported` | `test/custom-providers.test.ts`、`test/custom-provider-route.test.ts` |
| CPW-08 | 已有 key 的 provider 更改 endpoint/protocol 且无新 key 时为 `400`，持久 endpoint 与 `hasKey` 未变；相同 endpoint 的 keyless metadata 更新保留 key；Anthropic validation 的 cross-origin 3xx 为 `400`，目标 origin 零请求 | `test/custom-provider-route.test.ts`、`test/custom-providers.test.ts` |
| CPW-09 | oneShot 与 turn 在 snapshot 取得后发生 provider URL/key 更新时，实际 fetch 仍使用原 URL 和原 key；请求 custom model 在 snapshot 中被删除时，turn 在零 fetch 下拒绝；持久 Pi custom selection 在 stale registry 中不降级为内置模型 | `test/pi-harness-freshness.test.ts`、`test/runtime-selection.test.ts` |
| CPW-10 | `deepseek-local/deepseek-v4-flash` 保留 Pi DeepSeek `reasoning`、`compat`、`thinkingLevelMap`；带 tool history 的 fake OpenAI completion 请求含 `thinking`、`reasoning_effort` 和 assistant `reasoning_content` | `test/custom-providers.test.ts` |

开发顺序：先增加 CPW-01/02 的失败测试；实现后运行 Web UI 测试、typecheck、lint，并交由独立 fresh-context reviewer 复核。

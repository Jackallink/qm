# Round 3 — 集成与错误

| 条件 | UI 结果 | 不允许的结果 |
| --- | --- | --- |
| 自定义 ID 在 `modelsByHarness.pi` 且有完整 catalog 元数据 | 显示为 Pi 的可选模型，ID/name/provider/API 保持服务端值 | 因不是 OpenRouter 而被过滤或继承错误协议 |
| 自定义 ID 没有 catalog 元数据或协议类型 | 继续忽略该未知 ID，沿用已有 fallback | 浏览器猜测 provider/API 或把未知 ID 设为默认 |
| 模型不在当前 harness 的清单 | 不显示 | 跨 harness 显示或选择 |
| 未设显式 Web 模型清单，且模型在 core 当前 harness catalog 中 | core 接受该 turn，再执行既有 provider 可用性检查 | 菜单显示该模型而服务端以“未启用”拒绝 |
| 已设显式 Web 模型清单，且模型不在清单中 | core 拒绝该 turn | 自定义 provider 因已注册而绕过组织清单 |
| 自定义 ID 与另一个 custom provider、QM registry 或 Core 管理 provider 模型冲突 | provider 保存被拒绝；旧记录在运行时加载时被过滤 | 菜单显示 custom provider 元数据，而 Pi 实际调用另一个提供商 |
| 新 provider 使用 Pi 内置 provider slug | 保存被拒绝；已有 legacy 记录不自动改写 | 新的 `models.json` 覆盖 Pi 内置 provider |
| 历史记录使用 Core 管理 provider slug | 从 enabled registry、models.json 与 key snapshot 过滤，不能原地更新 | 旧 custom key 覆盖 Anthropic、OpenAI 或 OpenRouter 托管凭据 |
| 历史非 Core Pi slug 记录仍 active | 可原地轮换 key 或编辑；删除后不能重新创建 | 为兼容而允许创建新的 reserved slug |
| 两个并发写入认领同一 custom model ID | shared advisory lock 后仅一个保存成功，另一个返回 `400` | 两条 enabled 记录同时存在，再依赖运行时过滤补救 |
| 其他实例或本进程 registry 过期 | 下一次 runtime/surface 配置读取、新 turn、router 或 Pi async 模型调用先刷新 durable registry | 必须重启才能见到删除、改名或新增 provider |
| OpenRouter catalog 请求失败且 custom registry 已变化 | 保留已知 OpenRouter dynamic 项，重新合并 built-in 与当前 custom provider | 以旧 custom catalog 作为新 snapshot 并在 TTL 内继续展示已删除模型 |
| custom model 尝试使用 OpenCode | runtime selection/turn 准入拒绝 | 由长生命周期 sidecar 继续使用过期 URL 或 key |
| 已有 provider 更改 protocol/base URL 但未提交 key | 拒绝写入，旧 endpoint 与 encrypted key 保持不变 | 将旧 write-only key 发送给新地址 |
| endpoint validation 返回重定向 | validation 以 3xx 失败，绝不跟随 | protocol-specific key header 被转发到另一 origin |
| provider 更新或删除与 Pi execution 并发 | 一次 execution 使用同一 provider snapshot 的 model、models.json 与 key；删除的请求 model 在 fetch 前拒绝 | 旧 URL 配新 key、新 URL 配旧 key，或静默回退到默认内置模型 |
| durable Pi selection 与进程 registry 短暂失配 | 原 model ID 由 Pi durable snapshot 解析；snapshot 无该 ID 时拒绝 | router 将该请求改为内置默认模型并发送用户内容 |
| OpenAI-compatible DeepSeek alias 带 tool history 和推理等级 | 请求含 DeepSeek thinking/reasoning 参数，assistant replay 含 `reasoning_content`，但 endpoint/key 仍属于 custom provider | 因别名 slug 或 URL 不是 `deepseek` 而退化为普通 OpenAI wire shape |
| core 拒绝 runtime/turn | 保留既有错误反馈 | 浏览器将失败显示为已完成 |

## Stop 条件

若 Web UI 需要自定义 provider 的密钥或 URL 才能渲染模型，或能由用户输入绕过 core 目录和 runtime 校验，则停止发布并重新设计。

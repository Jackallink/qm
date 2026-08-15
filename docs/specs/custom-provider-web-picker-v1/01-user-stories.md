# Round 1 — 自定义模型 Web 选择器

## US-CPW-01：选择已批准的自定义模型

作为已认证用户，在管理员注册并启用一个自定义模型后，我能在 Web UI 的 Pi 模型菜单中看到它，并让下一条对话使用它。若组织没有另设 Web 模型清单，服务端准入与菜单使用同一按 harness 过滤的目录；若设有清单，清单仍优先。

验收：CPW-01、CPW-04。

## US-CPW-02：保留模型来源的真实标识

作为运营人员，我能从模型菜单和客户端状态看到 core 已返回的模型名称、provider 和协议类型，而不是错误地显示为某个内置提供商或协议。

验收：CPW-02。

## US-CPW-03：避免模型来源歧义

作为运营人员，当自定义模型 ID 与另一个 custom provider、QM registry 或 Core 管理 provider 的模型同名时，我会在保存前得到拒绝，而不是让一次请求静默发往另一个提供商。新 provider 也不能复用 Pi 内置 provider slug；但我可以用 `deepseek-local` 这类别名承载 provider-scoped 的 `deepseek-v4-flash` 模型 ID。

验收：CPW-05。

## US-CPW-04：配置变更在下一次选择时生效

作为管理员，我更新或删除一个自定义 provider 后，下一次 runtime config 读取或新 turn 会从 durable 配置刷新模型目录；并发管理员不能各自成功占用同一个模型 ID。自定义模型只支持 Pi，不能被 OpenCode sidecar 静默复用过期的 provider 配置。

验收：CPW-06、CPW-07。

## US-CPW-05：不让旧密钥流向新 endpoint

作为管理员，我可以不重新输入 key 来修改模型名称或清单；但一旦更改 provider 的协议或 endpoint，系统要求我提交新的 key，避免 write-only 的旧 key 被用于未经确认的新地址。

验收：CPW-08。

## US-CPW-06：执行使用一致的 provider 快照

作为管理员，当我更新或删除 provider 的同时有一个 Pi turn 开始时，该次执行要么完整使用更新前的模型地址和 key，要么在取得更新后的完整快照后使用新地址和新 key；它不能将新 key 发送到旧地址。若用户指定的 custom model 已在快照中删除，turn 在网络请求前拒绝，不得静默改用默认内置模型。

验收：CPW-09。

## US-CPW-07：DeepSeek 别名能完成推理工具续轮

作为使用 DeepSeek 自定义别名的用户，我在带工具的推理对话中仍能得到符合 DeepSeek 协议的后续请求，而不是因别名 URL 不含 `deepseek.com` 被当成普通 OpenAI 模型。系统保留 Pi 对该模型 ID 的静态 protocol 语义，但 URL、provider slug 和 key 始终来自我的 custom provider。

验收：CPW-10。

## 边界

- 普通用户不能手写任意 provider 或模型 ID。
- 浏览器不持有、不显示、不传输自定义 provider 的密钥。
- 客户端只消费无密钥的协议类型来构造显示模型；实际模型请求仍由 core 决定。
- 历史 `deepseek` 等非 Core 管理 Pi slug 记录可原地轮换；历史 `anthropic`、`openai`、`openrouter` 记录不能进入运行时或覆盖系统托管凭据。

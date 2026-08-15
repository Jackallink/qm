# Round 3 — 集成、错误与边界

| 情形 | 用户或操作员可见结果 | 系统动作 | 证据 |
| --- | --- | --- | --- |
| Docker daemon 不可用 | 启动失败 | 不创建任何半配置容器 | 命令退出码与诊断 |
| 端口已被占用 | 启动失败 | 指出服务与端口；不改写现有进程 | 命令退出码 |
| Docker 映射不是 loopback | 启动失败或验收失败 | inspect 和 IPv4/IPv6 连接测试不能标记 stack ready | 容器 inspect 与连接负测 |
| 镜像构建或拉取失败 | 启动失败 | 不报告 stack ready | build/pull 输出 |
| Postgres 不可用 | Core 不 ready | 边缘服务不宣称可用 | health 与容器日志 |
| disabled profile 仍要求 sandbox.app，设置 SANDBOX_SECONDARY_BACKEND，或选择非 disabled backend 但未配置可用外部 sandbox | check/up 失败 | 不创建控制面或尝试 Fly sandbox | 配置负测 |
| HTTP sandbox-backed 操作触达 disabled Sandbox | 501 capability_unsupported | 不创建 handle、进程、卷或网络调用 | handler 映射与 side-effect 负测 |
| harness Agent execute 触达 disabled Sandbox | run terminal failed，reason 为 disabled sandbox capability 拒绝 | `retryable: false` 阻止 worker 重试；不创建 Docker/Fly/AWS process | fake harness E2E 与 claim-count 断言 |
| 管理员读取或迁移 sandbox route | 404 not_supported | 不构造 migration runner 或 durable route map | admin route 负测 |
| Portal Playground 或 local bypass 被设置 | profile 校验失败 | 不启动为 D0-L ready；不创建匿名会话 | profile 与 Portal 启动负测 |
| Web 缺失 PORTAL_IDENTITY_SECRET，或 portal identity secret 与 verifier/Core 所用值错配 | Web 启动失败或请求 401 | 不采用 CORE_SIGNING_SECRET fallback，不转发身份到 Core | secret mapping 与 Web 认证负测 |
| 宿主 bootstrap 目标不是 loopback，source signature 或 portal identity 缺失/失效，identity 主体不匹配，或 actor 没有 admin grant | bootstrap 失败 | 不发送 provider/runtime mutation | CLI 与 Core 负测 |
| TEXT_ONLY_MODE 下管理或持久配置尝试选择非 Pi harness | 4xx refused 或 turn terminal failed | 不创建非 Pi session，不回退为其他 harness | admin/resource 与 harness-router 负测 |
| TEXT_ONLY_MODE 下管理或持久配置尝试选择 Pi builtin、未登记、没有可解密 key 或使用 HTTP endpoint 的 custom model | 4xx refused 或 turn terminal failed | 不创建模型 session；即使 managed provider credential 存在或旧 HTTP provider record 存在也不转发用户文本 | admin/resource、app admission 与 Pi snapshot 负测 |
| TEXT_ONLY_MODE 下管理面尝试登记 HTTP custom endpoint | 4xx refused | 在 endpoint/key 验证前拒绝，不把 key 发送到 endpoint，也不写入 provider record | custom-provider route 负测 |
| 宿主验证器目标不是 loopback，portal identity 缺失/失效，或请求不是文本 API | 验证失败 | 不创建成功 run；不访问 connector 或 keychain 路径 | CLI、Web 与 Core 负测 |
| TEXT_ONLY_MODE 收到 attachments、images、surface tool、proactive opener、poll/cron fire、automation/ambient 或其他非文本输入 | 4xx refused | 在 attachment materialization/provision 前拒绝；不创建成功 run，不注册或调度 Pi tools，不读写 memory/file/cron/sandbox | Core admission 与 Pi fake-provider 负测 |
| 无效或缺失 custom provider key | 文本请求失败 | 不生成成功 result；不记录 key | Web/Core 响应与审计 |
| endpoint 不可达 | 文本请求失败 | 失败可追踪；不假成功 | Core 结果与日志 |
| 单服务意外退出 | 健康临时失败后恢复或明确失败 | 不删除卷或伪造 ready | restart 与 health 记录 |
| non-purge down/up | 约定配置仍可读取 | 复用命名卷 | 持久化验证 |
| purge | 明确破坏性提示 | 删除本地卷后从空状态初始化 | runbook 与验证 |
| sandbox-backed create、exec 或 agent execute 请求 | 确定拒绝 | disabled sandbox backend 不使用 Fly sandbox、secondary backend 或 host socket | 负向测试 |

## 阻断项

- 容器化 Core 若需要本机 Docker sandbox 才能启动，D0-L 不通过；应改为明确的 text-only、fail-closed profile。
- Core 未设置 HARNESS=pi 或 SANDBOX_BACKEND=disabled 时，D0-L 不通过；不得以 mock 响应或 local Docker sandbox 代替真实文本验证。
- SANDBOX_SECONDARY_BACKEND 被设置或任何 sandbox-backed 路由回退到 secondary backend 时，D0-L 不通过。
- Core 不是 production，或 Portal 不是 development 且仍缺少 production OIDC/TLS 拓扑时，D0-L 不通过；不得把 PORTAL_PLAYGROUND 或 PORTAL_LOCAL_AUTH_BYPASS 用于该 profile。
- Core 未启用 TEXT_ONLY_MODE，或没有同时关闭 memory recall/capture、Pi tool definitions 时，D0-L 不通过；不得把模型提示词、readOnly 或 disabled sandbox 当作零工具边界。
- bootstrap 未同时提供有效 source-auth 与绑定到预置 admin grant 的短期 portal identity 时，D0-L 不通过；不得以 x-admin-actor 或 Core signing secret 代替 portal identity。
- 任一公开端口绑定全部接口而非 loopback，D0-L 不通过。
- 任何服务只由日志正则而不是 loopback healthz HTTP probe 判为 ready，D0-L 不通过。
- non-purge 生命周期没有同时保留 pgdata 和 coredata，D0-L 不通过。
- 正常状态、日志、build context 或镜像层出现模型 key，D0-L 不通过。
- connector secret 在 non-purge down/up 后变更而导致已存 provider key 无法解密时，恢复验证失败；不得静默把该 provider 视为可用。
- 真实模型失败返回成功形状，D0-L 不通过。

## 不能外推的结论

D0-L 的成功不证明 Docker daemon 管理员无法读取容器环境变量，也不证明生产网络隔离、Docker host 隔离、可信终止、凭据撤销、Kubernetes、HA、灾难恢复、治理授权、Portal 浏览器 E2E、production Portal/OIDC/TLS、浏览器 Admin E2E 或 Remote Turn 一次性执行语义。

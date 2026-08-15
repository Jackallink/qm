# Round 2 — 技术追踪

## 路径 A：构建并启动

| 步骤 | 责任组件 | 可验证结果 |
| --- | --- | --- |
| 1 | 操作员选择 local Docker profile 并提供本机秘密文件 | profile 以 `sandbox: { "backend": "disabled" }` 作为唯一 SANDBOX_BACKEND 来源，以 `env.core.TEXT_ONLY_MODE=true`、`MEMORY_RECALL=off` 与 `MEMORY_CAPTURE=off` 声明 text-only；Core 配置要求它同时为 HARNESS=pi 与 SANDBOX_BACKEND=disabled，其他组合加载失败。`env.core` 或 `secretEnv.core` 试图设置两项 sandbox backend 变量均被配置校验拒绝。提供 CAPABILITY_SECRET、CORE_SIGNING_SECRET、PORTAL_IDENTITY_SECRET、CONNECTOR_SECRET_KEY 与 SKILL_SIGNING_SECRET，其中前三者彼此不同，Connector key 不复用前三者。CLI 的 computed secret mapping 必须把 PORTAL_IDENTITY_SECRET 和 CORE_SIGNING_SECRET 分别交付给 Web；production Web 缺失 PORTAL_IDENTITY_SECRET 必须启动失败，而非采用 chassis 的 Core-signing fallback。Portal 使用 NODE_ENV=development、loopback public URL、稳定的 PORTAL_SESSION_SECRET 和同一 PORTAL_IDENTITY_SECRET；PORTAL_PLAYGROUND 与 PORTAL_LOCAL_AUTH_BYPASS 必须未设置。profile 必须以 `secretEnv.core.ADMIN_GRANTS: "ADMIN_GRANTS"` 显式映射受保护本机 `.env` 或进程环境中的 `ADMIN_GRANTS=<principal>:org_admin`；未映射的 `.env` 键不得自动进入容器。配置只引用本地秘密，不回显值。 |
| 2 | Docker backend 校验 daemon、profile、端口和数据卷 | 端口映射必须请求 127.0.0.1；`sandbox.backend: "disabled"` 只允许 Docker target，并拒绝 sandbox.app、image、baseImage、env 与 secretEnv；disabled Docker profile 不要求 sandbox.app，并拒绝设置 SANDBOX_SECONDARY_BACKEND；缺失条件返回错误；不会创建半启用的 execute 路径。 |
| 3 | Docker backend 创建私有网络、Postgres 卷和服务容器 | Core、Web、Admin、Portal、Postgres 都在同一命名网络，且所有宿主发布端口经 inspect 可见为 loopback。 |
| 4 | 服务健康检查 | 每个服务报告 ready 或带有服务名的失败。 |
| 5 | 状态命令 | 返回容器、镜像标识、loopback 端口与卷状态，不含 secrets。 |

## 路径 B：宿主 bootstrap

| 步骤 | 责任组件 | 契约 |
| --- | --- | --- |
| 1 | `qm local bootstrap` | 只接受配置确定的 loopback Core URL、权限为 0600 或更严格的本机 secret 文件和 local admin principal；从该文件读取 `D0L_PROVIDER_API_KEY`，拒绝非 loopback URL、缺失 source-auth secret、缺失 portal identity secret、缺失 provider key 或不在 ADMIN_GRANTS 中的主体。命令拒绝 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（及小写变体）、`NODE_USE_ENV_PROXY` 与 `--use-env-proxy`，并拒绝任何 3xx；每个请求及未完成响应 body 均有有界超时和 abort，不能把 key、source-auth 或 identity 交给代理或无限期占用 socket。 |
| 2 | signed Core admin request | 命令以 source-auth 签名，并用 PORTAL_IDENTITY_SECRET 为同一 admin principal mint 一分钟内有效的 x-portal-identity；先 PUT org approved-harnesses，body 为 `{ "ids": ["pi"] }`。TEXT_ONLY_MODE 的管理面拒绝任何其他 harness；运行时 resolver 对请求或持久配置中的非 Pi choice 同样 fail closed。 |
| 3 | signed Core admin request | 命令以同一两种身份证明 PUT 到 `/v1/admin/custom-providers/:provider`，body 为 `{ "name": "<name>", "protocol": "openai|anthropic", "baseUrl": "https://<endpoint>", "models": [{ "id": "<model-id>", "name": "<model-name>", "contextWindow": <positive-int>, "maxTokens": <positive-int> }], "apiKey": "<write-only key>", "validate": true }`。Core 从 identity 推导 actor，不以 x-admin-actor 作为授权依据。key 只存在于命令进程和 Core 加密写入路径。 |
| 4 | Core custom provider store | Core 验证 source-auth、portal identity、主体一致性与通过 `secretEnv` 注入的 admin grant，验证或保存 provider，写入 Postgres durable custom-model-providers record；响应永不返回 key。 |
| 5 | signed Core admin request | 命令以同一两种身份证明 PUT 到 `/v1/admin/scopes/org:<org>/runtime`，body 为 `{ "harnessId": "pi", "modelId": "<registered-model-id>" }`。 |
| 6 | Core runtime config | Core 验证 harness、模型和 provider key 可用；text-only 额外要求模型来自 enabled custom-provider snapshot 且该 provider 存在可解密 key，拒绝 Pi builtin 或 keyless custom model，随后写入 org scope runtime selection。 |

## 路径 C：受限宿主验证器的真实文本回合

| 步骤 | 责任组件 | 契约 |
| --- | --- | --- |
| 1 | `qm local verify` | 只接受配置确定的 loopback Web URL、权限为 0600 或更严格的本机 secret 文件和 QA principal；用 PORTAL_IDENTITY_SECRET mint 一分钟内有效的 x-portal-identity，并 POST `/api/turn`，body 为 `{ "text": "<smoke text>", "threadRef": "web:<principal>:d0l-smoke" }`。它不使用浏览器 cookie、Portal Playground 或 connector/keychain API；与 bootstrap 一样拒绝代理环境、3xx 和超时未完成的 response body。 |
| 2 | Web | Web 使用显式 PORTAL_IDENTITY_SECRET 验证 token 与 `threadRef` 中的主体，并使用独立 CORE_SIGNING_SECRET source-auth 调用 Core；缺失或错配的 portal identity secret 返回认证失败，不能回退为 Core signing secret。 |
| 3 | Core text-only admission | Core 的 TEXT_ONLY_MODE 在入队和 model/provider selection 前只接受文本与正常 conversation metadata；attachments、images、surface tools、proactive opener、poll/cron fire、automation/ambient、请求级 harness/model/effort override 与任何非文本 payload 都被拒绝，且不创建成功 run。用于模型回放的既有 session history 只投影未标记 `hidden` 或 `steered`、且不带文件载荷的 user/assistant 纯文本，不能把旧自动输入或旧运行信号送往 provider。text-only 不枚举默认 plugin skill dirs，也不接受 `PLUGIN_SKILLS_DIRS`；它不 seed 或读取 skill 文件，不等待或读取既有 skills/connector 配置，也不把 `## Skills` 或 deployment hints 写入 provider prompt。它强制 effective readOnly，阻止 eager/control-token/provision 分支；拒绝必须发生在 inbound attachment materialization/provision 前。它不读取或写入 memory，因 MEMORY_RECALL 与 MEMORY_CAPTURE 都为 off；DM onboarding 亦不得绕过 recall=off 读取 memory。成功回合同样跳过 workspace `ensureScope`，所以不创建 agent workspace 目录。 |
| 4 | Core runtime selection 与 Pi | 服务端选择 Pi 与已登记 custom model；无效/过期 identity、无效模型或配置被拒绝。管理面只接受 approved-harnesses `["pi"]` 和 Pi runtime；turn resolver 对请求或持久配置中的非 Pi choice fail closed。text-only 在每次 selection 时从 durable custom-provider snapshot 验证该 model 和可解密 key；Pi builtin、keyless custom model 或已删除 provider 均 fail closed，即使可选 managed provider credential 恰好存在。Pi 的 textOnly option 以 `noTools: "all"` 与 `customTools: []` 创建每一个 AgentSession；provider request 不含 tool definitions，不能 dispatch `createPiTools` 中的 execute/read/write/publish/memory/history/background/cron/surface tools。标题、判定、压缩、安全筛查、确认摘要和 emoji 等辅助模型调用在 text-only 中均关闭；provider refusal 不得回退到其他模型。运行信号入口不可用，因此不会以 steer 创建或注入第二个 prompt。成功受理返回 runId。 |
| 5 | Pi custom provider | 仅从同一次受保护持久 custom-provider snapshot 取得 endpoint、model semantics 和 key，向配置 endpoint 发起文本调用。Core 在 `TEXT_ONLY_MODE=true` 时、且在 `buildApp` 前安装强制 `redirect: "manual"` 的 fetch transport；Pi 所构造的 OpenAI 与 Anthropic SDK client 都使用该 transport。任一 3xx 都在原 endpoint 处失败，不跟随到重定向 target，因此不把 prompt 或 provider key 交给第二个 origin。 |
| 6 | 验证器轮询回应 | 验证器携带同一 identity 轮询 `GET /api/runs/:runId`，只在 terminal done 且 reply 完整时记录真实文本成功；failed、超时或无 runId 均为失败，绝不映射为成功。 |

## 路径 D：Portal 容器边界

| 步骤 | 责任组件 | 契约 |
| --- | --- | --- |
| 1 | 浏览器或 HTTP 客户端访问 loopback Portal | Portal 的 healthz 返回 ready；没有会话的应用请求被导向登录或返回 401。 |
| 2 | D0-L profile | PORTAL_PLAYGROUND 与 PORTAL_LOCAL_AUTH_BYPASS 均未设置，因此 D0-L 不创建匿名会话，也不验证 Portal 到 Web 的文本、Admin、connector 或 keychain 路径。 |

## 路径 E：重启与恢复

| 步骤 | 责任组件 | 契约 |
| --- | --- | --- |
| 1 | 操作员执行 docker restart qm-<org>-<service> 或 non-purge down | restart 只停止指定服务；non-purge down 只删除容器，不删除 pgdata 或 coredata 卷。 |
| 2 | Docker backend 按依赖顺序启动服务 | Postgres ready 后 Core 再启动，随后边缘服务恢复；每个公开服务以对应 loopback healthz HTTP probe 判定 ready，不能只依赖日志正则。 |
| 3 | Core 重新读取持久状态 | Postgres session/run store、custom-model-providers durable record 和 scope runtime selection 可由 API 读取；未解密的 key 不得被当作可用。 |
| 4 | health 与文本 smoke | 健康恢复，已登记 custom provider 和 scope runtime selection 可完成实际文本调用，或得到明确失败。 |

## 路径 F：未纳入的 execute

| 步骤 | 责任组件 | 契约 |
| --- | --- | --- |
| 1 | `src/config.ts` 与 `src/sandbox/sandbox-routing.ts` | `SANDBOX_BACKEND=disabled` 只可作为 primary backend；`SANDBOX_SECONDARY_BACKEND` 只能取实际可构造、可路由的 backend，且 primary 为 disabled 时任何 secondary 值均使配置加载失败。`disabled` 不加入 SandboxBackendName 或 migration target union。`PUBLIC_API_URL` 在 disabled profile 不再是 Pi 的必填项，因为没有 sandbox 能调用它。 |
| 2 | `src/wiring.ts` | 对 `config.sandboxBackend === "disabled"` 的窄化分支只构造 `createDisabledSandbox()`；不得构造 local、sprites、aws、sandbox router、sandbox route durable map 或 sandbox migration runner，也不得 mint migration egress token。只有非 disabled 分支才构造可路由 backend record。`BuiltApp.sandboxMigration` 为 absent，`src/index.ts` 不向 ServerDeps 注入它。 |
| 3 | `src/sandbox/disabled-sandbox.ts` | AgentComputerProfile 的 writablePersistence union 增加 `"none"`；disabled profile 为 `{ backend: "disabled", writablePersistence: "none", processSessions: false, egressEnforcement: "none" }`，不暴露 optional process、backup、staging 或 reaper capability；全部必需 Sandbox interface 方法都 reject `new CapabilityUnsupportedError("disabled", "sandbox execution")`。该 error 带 `retryable: false`；不创建 handle、进程、卷或网络调用。 |
| 4 | HTTP 与管理面 | `GET /v1/admin/sandbox-routes` 与迁移路由因没有 runner 返回现有 `404 { "error": "not_supported" }`。任何 HTTP handler 未捕获的 CapabilityUnsupportedError 由 `src/api/server.ts` 映射为 `501 { "error": "capability_unsupported", "backend": "disabled", "capability": "sandbox execution" }`，而不是 generic 500。 |
| 5 | 内部 Agent execute 负测 | `src/core/turn-error.ts` 的共享 terminal-error 判定同时识别 NonRetryableTurnError 与 `retryable: false` 的 CapabilityUnsupportedError；`src/runs/worker.ts` 因而不重试，`src/core/orchestrator.ts` 记录 terminal failure payload。独立 mock-harness/ToolContext 负测若调用 `execute`，tool primitive 在 `provision()` 处得到同一 CapabilityUnsupportedError，run 以 `status: "failed"` 与该确定、安全 reason 结束，且不创建 Docker/Fly/AWS process。正常 Pi text-only 回合没有任何 tool dispatch，因此不依赖 Pi agent-core 对 tool exceptions 的处理。 |
| 6 | 验收探针 | 单元测试直接覆盖 disabled Sandbox 的 provision/run/read/write/teardown 与 `retryable: false`；集成测试证明 disabled wiring 未调用任一真实 backend 或 migration runner，admin sandbox routes 为 404，HTTP error 为 501，mock Agent execute 的 run 为 terminal failed、只 claim 一次、零外部执行；另以真实 Pi adapter/fake provider 捕获 request，证明 zero custom/builtin tool definitions、零 ToolContext dispatch 与零 agent-mediated memory/workspace/artifact/cron/sandbox 副作用。session/run/audit 持久化和 Pi 隔离临时资源不在该断言内。 |

通用工具、文件和 workspace 功能不属于 D0-L；本阶段只承诺上述 sandbox execution 拒绝，而不把每一种不依赖 sandbox 的工具行为宣称为已验证。

## 数据与网络边界

- pgdata 保存 Postgres 数据；coredata 保存 Core data directory。non-purge down/up 保留两者；显式 purge 删除两者并从空状态初始化。
- 本机 env 文件不进入镜像 build context、Git 或状态输出。
- build-from 验证记录 Git HEAD、dirty 状态和各服务镜像 content ID；发布镜像验证记录不可变 digest。
- 自定义 Docker 网络只提供容器寻址，不限制 Core 到 custom provider endpoint 的 HTTPS 出口，也不构成 egress 安全证明。
- Core、Web 与 Admin 的 host 端口只能绑定 loopback，供本机诊断、bootstrap 和验证器；验证器是本机 QA 文本路径，不是浏览器 Portal/Admin 登录或生产权限模型的证据。

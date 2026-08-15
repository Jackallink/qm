# D0-L 本地 Docker 基线 v1

## 状态

walkthrough-approved；Gate 2 TDD in progress。此规格定义本机全容器控制面的可复现验证基线。它不替代目标交付环境可行性、治理连接、参考运行时证明或 Remote Turn 的任何门禁。

当前已通过的 dev-instance 仅是混合本地开发形态：Core、Web、Admin 与 Portal 在宿主机运行，Postgres 与本地 sandbox 使用 Docker。它可证明一次真实 custom provider 文本调用和本地 Postgres 可用，但不能称为本规格的全 Docker 证据。

当前 Docker backend 尚未满足本规格：公开端口默认由 Docker 绑定到全部宿主接口；production Core 要求显式 sandbox backend；容器化 Core 不能安全地调用宿主 Docker sandbox；production Portal 不能在 plain-HTTP localhost 上省略 OIDC/TLS 启动条件。D0-L 因而使用 production Core 加 development health-only Portal 的受限本地 QA 组合，而不是把开发身份 bypass 带进容器。它们均是本规格的实现和测试对象，不可被当前启动脚本或 mock lifecycle test 掩盖。

## 目标

在一台开发机的 Docker daemon 上，使用现有 Docker backend 运行 Core、Web、Admin、Portal 与 Postgres，并提供一条可重复、仅本机暴露的文本模型验证路径：

1. 操作员可构建、启动、查看状态和日志，并在不清除卷的情况下停止后恢复。
2. 已保存的本地运行配置与 custom provider 配置在服务容器重启和完整 down/up 后仍可读取。
3. 本机受限验证器可经 Web、Core、Pi 完成一条真实的受控文本模型调用；错误凭据或不可达 endpoint 必须明确失败。
4. 所有公开宿主端口只绑定 loopback；密钥不进入 Git、镜像层、状态输出或普通日志。

## 范围

纳入：

- 复用现有 Docker backend 和已有服务镜像，以容器启动 Core、Web、Admin、Portal 与 Postgres。
- 为本地 profile 定义服务清单、命名网络、数据卷、端口、构建来源、非秘密配置和秘密加载位置。
- 使文本模型路径可在没有 Fly 或其他云 sandbox 依赖的情况下 fail-closed 启动；该路径不得伪装为 agent execute。
- 定义 TEXT_ONLY_MODE=true：该 profile 只能与 HARNESS=pi、SANDBOX_BACKEND=disabled、MEMORY_RECALL=off、MEMORY_CAPTURE=off 组合；Pi 会话注册零 custom/builtin tools，非文本输入、请求级 model/harness 覆盖，以及没有可解密 key、或未使用 HTTPS endpoint 的 builtin 或 custom model selection 均在 admission 被拒绝。实际选择只能是已登记、具有可解密 key 且使用 HTTPS endpoint 的 custom provider 模型。它不以“模型不会调用工具”的提示词或 disabled sandbox 的运行时失败作为边界。
- 定义 SANDBOX_BACKEND=disabled：它是没有 Pi 工具时仍需保留的独立 fail-closed substrate；任何直接 sandbox interface create、exec 或内部 Agent execute 调用得到 CapabilityUnsupportedError，backend 为 disabled、capability 为 sandbox execution，而不是隐式 local Docker 调用。
- Docker target 在 SANDBOX_BACKEND=disabled 时不得要求或同步 sandbox.app；若选择任何需要外部 sandbox 的 backend，local text-only profile 必须在启动前拒绝。
- Portal 作为容器化控制面成员完成 health 与默认未认证拒绝验证；D0-L 不允许 Portal Playground、PORTAL_LOCAL_AUTH_BYPASS、浏览器文本或浏览器 Admin 路径。
- 定义仅宿主可运行的 signed bootstrap 与文本验证器：`qm local bootstrap` 通过 Core admin API 登记 custom provider，再设置 org scope 的 Pi runtime selection；`qm local verify` 只通过 loopback Web API 发起文本回合。二者只接受权限为 0600 或更严格的本机 secret 文件；bootstrap 从该文件读取 `D0L_PROVIDER_API_KEY`，需要预先设置的 Core admin grant，并同时发送 source-auth 与短期 signed portal identity。
- 容器构建、启动、健康、日志、单服务重启、完整 down/up、持久化与真实 custom provider 文本 smoke 验证。
- 明确 down 与 purge 的数据语义，且在运行手册中给出恢复和清理步骤。

不纳入：

- Kubernetes、HA、多节点、灾难恢复、正式 ingress、生产 IAM 或外部治理连接。
- Agent execute、工具、文件、挂载工作区、host Docker socket、Docker-in-Docker、可信 egress、attestation 或 Remote Turn。
- 将本机 Docker 视为生产隔离、不可旁路网络控制、真实终止证明或 F1 放行证据。
- 生产 Portal/OIDC/TLS 登录、浏览器 Admin 配置和本地邮件或外部身份提供方。它们属于 D0-Lb 本地浏览器身份子阶段，必须另立规格与门禁，不能由 Playground 或 bootstrap 冒充。
- 在 generic core 中写入组织、模型密钥、外部端点或私有治理细节。

## 安全与真实性不变量

1. 全 Docker 只能描述 Core、Web、Admin、Portal 和 Postgres 的控制面；未被验证的 sandbox/agent execute 不可启用或宣称可用。
2. 本地 profile 不得要求 Fly sandbox app，也不得以宿主 Docker socket 换取执行能力。
3. 宿主公开端口仅绑定 127.0.0.1；IPv4 和 IPv6 的 Docker inspect 与连接测试均不得显示全接口发布；Web/Admin/Core 的直连端口仅是本机调试面。D0-L 的文本验证只能由受限宿主验证器经 loopback Web 完成；Portal 只验证 health 与未认证拒绝。
4. 数据卷在非 purge down/up 中保留；purge 必须是显式、可见的破坏性操作。
5. 配置、模型 key 和文本调用失败均不得被映射为成功结果。
6. 本规格的完成只允许标记 D0-L 完成；D0-T、G0、X0 和 F1 仍维持各自的独立门禁。
7. Docker daemon 管理员可读取容器环境变量；本规格只要求密钥不进入 Git、build context、镜像层、CLI 常规输出或应用日志，不把本机 Docker 当作针对 daemon 管理员的秘密边界。
8. Docker 自定义网络不是 egress 隔离。Core 为真实 custom provider 文本调用保留 HTTPS 出口；本规格不声称该出口受强制代理、域名 allowlist 或可信计量控制。
9. Core 必须以 production 启动，并提供 CAPABILITY_SECRET、CORE_SIGNING_SECRET、PORTAL_IDENTITY_SECRET、CONNECTOR_SECRET_KEY 与 SKILL_SIGNING_SECRET；前三者彼此不同，CONNECTOR_SECRET_KEY 不得复用前三者。CLI 必须将 PORTAL_IDENTITY_SECRET 和 CORE_SIGNING_SECRET 分别传给 Web；production Web 缺失前者时拒绝启动，不能回退为 CORE_SIGNING_SECRET。Portal 仅以 development 模式在 loopback 发布，且 PORTAL_PLAYGROUND 与 PORTAL_LOCAL_AUTH_BYPASS 必须未设置。PORTAL_SESSION_SECRET 与 Connector、Skill 相关 secret 在 non-purge 生命周期内保持稳定。Portal 的开发模式只在 D0-L profile 中存在，不是生产入口。
10. bootstrap 不是登录或授权替代品：它只能为已经通过 ADMIN_GRANTS 配置的本机管理员主体 mint 一分钟内有效的 portal identity，并只能访问 loopback Core。Core 从该 identity 推导管理员主体，bootstrap 不把 x-admin-actor 当作授权依据。它不签发浏览器会话，也不启用 Portal Admin。

## 验收标准

| ID | 所需结果 |
| --- | --- |
| D0L-01 | 一个版本化 local Docker profile 列明服务、命名网络、两类命名卷、端口、秘密来源和清理语义；构建证据必须记录 release digest，或 build-from 的 Git HEAD、dirty 状态和每个镜像 content ID。 |
| D0L-02 | Core、Web、Admin、Portal、Postgres 均是同一 Docker 网络中的容器；Docker inspect 与 IPv4/IPv6 连接测试证明宿主端口仅监听 loopback。 |
| D0L-03 | up、status、logs、docker restart 单服务、down、non-purge up 均可重复执行，并有明确的错误输出和 HTTP healthz 恢复检查。 |
| D0L-04 | Core 与 Portal 的 healthz 恢复；Postgres session/run store、custom-model-providers durable record 和 scope runtime selection 经 restart 与 non-purge down/up 后可由相应 API 读取；Postgres pgdata 和 Core coredata 均保留，稳定 connector secret 能解密同一 provider key。 |
| D0L-05 | `qm local bootstrap` 以预置 admin grant、source-auth 和短期 portal identity 登记 provider 与 Pi runtime selection；`qm local verify` 以短期 portal identity 经 Web、Core、Pi 完成真实文本模型调用。TEXT_ONLY_MODE 只允许纯文本和已登记、具有可解密 key 且使用 HTTPS endpoint 的 custom-provider Pi model，Pi provider request 无 tool definitions，且零 agent-mediated memory/workspace/artifact/cron/sandbox 副作用；正常的 session/run/audit 持久化和 Pi 的隔离临时资源不在该断言内。无效/失效 identity、缺失或错配的 Web identity secret、内置或未配置 key 的模型、HTTP custom endpoint、无效 key 或不可达 custom endpoint 返回失败而非成功形状。 |
| D0L-06 | 密钥不写入 Git、build context、镜像层、普通状态输出或应用诊断日志；文档说明 Docker daemon 管理员边界和 purge 的破坏性影响。 |
| D0L-07 | SANDBOX_BACKEND=disabled 被配置、解析和 wiring 接受，SANDBOX_SECONDARY_BACKEND 必须未设置且被 profile 拒绝；Docker check/up 在没有 sandbox.app 时通过；任何直接 sandbox-backed create、exec 或内部 Agent execute 调用返回带 `retryable: false` 的 CapabilityUnsupportedError，其中 backend 为 disabled、capability 为 sandbox execution；该内部 failure 因而 terminal failed 而不重试，不尝试 Fly app 或 host Docker socket。D0-L 的 Pi 文本回合不注册任何工具，故不会把此内部负测冒充为 Pi Agent execute 支持。 |

## 风险与回滚

风险包括端口误暴露、卷误删、旧 Fly sandbox 假设阻止本地启动、服务重启后配置漂移、host bootstrap 的管理员身份误用，以及为使 execute 可用而错误暴露 Docker socket。

回滚是停止并移除该 profile 的服务容器而保留 pgdata 与 coredata 命名卷；恢复到已验证的混合 dev-instance 仅作为本地 QA 手段。只有操作员显式执行 purge 时才删除两卷。若 bootstrap 已登记临时 provider，回滚报告必须显示其 ID 并由管理员显式删除；任何本地 profile 的未知执行、端口暴露或配置丢失都使 D0-L 回到 draft，不能向后续门禁外推。

## 关联记录

- [Round 1：用户故事与验收](./01-user-stories.md)
- [Round 2：技术追踪](./02-technical-trace.md)
- [Round 3：集成、错误与边界](./03-integration-errors.md)
- [AC 到测试矩阵](./04-test-matrix.md)
- [验证与偏差记录](./05-validation-and-drift.md)
- [程序级路线图](../agent-platform-roadmap-v1/README.md)

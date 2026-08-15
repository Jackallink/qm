# Round 1 — 用户故事与验收

## US-01：启动本机全容器控制面

作为本地开发者，我希望用一个明确的 local Docker profile 启动完整控制面，以便不依赖 Kubernetes、Fly 或宿主 Node 进程做集成验证。

验收：

- 启动结果列出 Core、Web、Admin、Portal、Postgres 容器及其健康状态。
- 任一所需镜像、网络、卷、秘密或端口条件缺失时，命令失败并给出可操作原因。
- Docker inspect 与 IPv4/IPv6 连接测试证明宿主端口只监听 127.0.0.1。

## US-02：执行真实文本模型验证

作为本地管理员，我希望通过受限的本机验证器发起一次真实 custom provider 文本请求，以便确认容器间路径、持久配置和模型 key 均真实可用。

验收：

- 请求经过 Web、Core 与 Pi，返回已登记、带可解密 key 且使用 HTTPS endpoint 的 custom provider 模型的真实响应；Pi 内置模型、没有 key 的 custom provider model 和 HTTP custom endpoint 不能在 text-only 中被选中。
- 无效 key、无效模型或不可达 endpoint 返回可见失败，不创建成功的 run/result。
- 只有宿主 bootstrap 从受保护本机文件读取模型 key，并经 loopback Core 管理 API 写入；key 不进入浏览器、普通 CLI 参数、状态/诊断输出、应用日志或响应。
- 宿主 bootstrap 使用预置 Core admin grant、source-auth 和短期 portal identity 登记 provider 与 Pi runtime selection；宿主验证器只请求 Web 的文本回合 API。Portal 在 D0-L 中不接受 Playground、browser text 或 Admin 路径。
- TEXT_ONLY_MODE=true 只接受纯文本；Core 拒绝 attachments、images、surface tools、cron/poll fire 与自动化输入，Pi 以 `noTools: "all"` 和零 customTools 创建会话，MEMORY_RECALL 与 MEMORY_CAPTURE 均为 off。模型请求中不出现 tool definitions，且没有 agent-mediated memory/workspace/artifact/cron/sandbox 副作用；session/run/audit 持久化和 Pi 隔离临时资源不在该断言内。

## US-03：重启后继续本地验证

作为本地开发者，我希望重启一个容器或完整 down/up 后保留约定的数据，以便验证本机卷与启动顺序不是一次性演示。

验收：

- 不 purge 的 down/up 保留 session/run store 和已登记 provider/runtime 配置。
- Core、Web、Admin 或 Portal 单独重启后健康检查恢复。
- 显式 purge 才会删除本地卷，运行手册提前说明后果。

## US-04：不把未验证能力误报为可用

作为安全审阅者，我希望 Docker profile 对 agent execute、工具和 sandbox 边界明确拒绝或不暴露，以便本地文本验证不会被误当成受控 Agent 运行时。

验收：

- Core 明确使用 SANDBOX_BACKEND=disabled，不需要 Fly sandbox app。
- 不挂载宿主 Docker socket。
- text-only profile 使用显式 disabled sandbox backend，且 SANDBOX_SECONDARY_BACKEND 未设置；Pi 正常文本回合零工具注册。直接 sandbox-backed create、exec 与内部 Agent execute 返回确定拒绝，文档明确它们不在 D0-L 范围，且不把该内部负测描述为 Pi Agent execute。
- 验证器请求体只允许文本、固定 threadRef 和已登记 runtime selection；通用工具行为不属于 D0-L 的验收承诺。

## US-05：不把本地 QA 身份当作正式浏览器登录

作为安全审阅者，我希望本地 Docker 冒烟的身份边界可解释，以便测试便利不会变成生产入口或管理员绕过。

验收：

- Core 保持 production，三个 Core 安全 secret 彼此不同；Portal 仅以 development 模式作为 loopback health 成员，Playground 与 local bypass 均未设置。
- bootstrap 只能使用与 ADMIN_GRANTS 匹配的主体，且请求同时具有有效 source-auth 和一分钟内有效的 portal identity。
- 宿主验证器使用短期 portal identity，只请求 Web 文本 API；缺失/失效 identity 不能创建文本 run。Web 必须显式接收 PORTAL_IDENTITY_SECRET 与 CORE_SIGNING_SECRET；缺失或错配的 portal identity secret 不能由 Core signing secret fallback 掩盖。
- 本阶段不声称有 Portal 浏览器 E2E、production Portal/OIDC/TLS 或浏览器 Admin；它们在独立的 D0-Lb 本地浏览器身份阶段验收。

## 非故事

- 不是生产部署或 Kubernetes 验收。
- 不是高可用、可信 egress、attestation、设备管理或治理集成。
- 不是 Remote Turn、Agent 平台、工具执行或常驻任务。

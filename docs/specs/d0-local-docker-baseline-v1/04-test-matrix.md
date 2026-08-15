# D0-L 验收与测试矩阵

| AC | 自动化证据 | 本地人工证据 | 当前状态 |
| --- | --- | --- | --- |
| D0L-01 | Docker profile 配置、服务清单、HARNESS=pi、唯一 `sandbox.backend=disabled` 来源、拒绝 backend env 覆盖、秘密序列化与 build identity 测试 | 记录 Git HEAD、dirty 状态和镜像 content ID，或发布 digest | pending |
| D0L-02 | Docker backend 容器、网络、Docker inspect、IPv4/IPv6 loopback 端口断言 | docker ps 与端口检查 | pending |
| D0L-03 | lifecycle test 覆盖 up/status/logs/docker restart/down/non-purge up；每个公开服务 healthz HTTP probe | 操作手册逐步执行 | pending |
| D0L-04 | Postgres session/run、custom provider、scope runtime selection 以及 pgdata/coredata 的 restart/down-up 读写和实际后续模型调用 | 完整 down/up 后读取配置与 healthz | pending |
| D0L-05 | `cli/test/local-docker-host.test.ts` 的 signed bootstrap provider/runtime 成功和拒绝、source-auth、portal identity、admin grant、0600 secret-file、固定 loopback/API allowlist、代理环境/3xx 拒绝、未完成真实 response socket abort 与 terminal reply 测试；Web 显式 portal/core secret 的正确、缺失、错配负测；Pi builtin、keyless custom model 或 legacy HTTP endpoint 的 runtime/admission 拒绝；text-only provider HTTP registration 在 key 验证前拒绝且零 endpoint fetch；`test/text-only-mode.test.ts` 以真实双 loopback provider 覆盖 OpenAI 与 Anthropic SDK 的 307，断言 `TEXT_ONLY_MODE` transport 不跟随重定向 target，target 收到零 prompt/key；TEXT_ONLY_MODE 配置层忽略 `PLUGIN_SKILLS_DIRS` 且不枚举默认 plugin skill dirs；Pi request 零 tool definitions、零 custom tool dispatch、零 skill seed/read、零 `## Skills`/deployment-hint prompt ingress、旧 `hidden`/`steered` history 零 provider replay、零 workspace `ensureScope`、零 agent-mediated memory/workspace/artifact/cron/sandbox 副作用；Web/Core fake endpoint 成功/失败 E2E；Portal health 与无会话拒绝 | 一次真实 custom provider 文本 smoke | pending |
| D0L-06 | Git、build context、镜像、状态输出、应用日志 secrets 负向测试 | 审阅本机 env 文件与命令输出；记录 Docker daemon 管理员边界 | pending |
| D0L-07 | SANDBOX_BACKEND=disabled 配置与 PUBLIC_API_URL 例外、SANDBOX_SECONDARY_BACKEND 拒绝、无 sandbox.app 的 Docker check/up、disabled Sandbox interface 与 `retryable: false`、未构造真实 backend/router/migration、admin route 404、HTTP 501 capability_unsupported、fake Agent execute terminal failed/单次 claim/零外部执行测试 | 运行手册范围审阅 | pending |

实施只能在对应 P0/P1 测试先失败、Round 1 至 Round 3 获批准后开始。

## Gate 2：先失败的测试切片

| 切片 | 先写的测试 | 失败原因 | 通过条件 |
| --- | --- | --- | --- |
| disabled Core substrate | `test/config.test.ts`、`test/disabled-sandbox.test.ts`、`test/admin-sandbox-migrate.test.ts`、`test/orchestrator.test.ts` | 当前 Config 不接受 disabled；wiring 会构造真实 backend/router/migration；CapabilityUnsupportedError 会被重试 | disabled 直接 sandbox、无 runner 的 404、501 error mapping、单次 claim terminal failure 均成立 |
| text-only Pi boundary | 新 `test/text-only-mode.test.ts`、`test/pi-harness-oneshot.test.ts`、`test/turn-options.test.ts` | 当前 Pi 总会注册 `createPiTools()`；attachments 可在 admission 前 materialize；DM onboarding 可读取 memory | non-text input 在 provision 前拒绝；Pi request 零 builtin/custom tool definitions；零 ToolContext 与 agent-mediated memory/workspace/artifact/cron/sandbox 副作用；非 Pi choice fail closed |
| Web identity boundary | `plugins/web-ui/test/signed-identity.test.ts`、`plugins/web-ui/test/auth-mode-portal.test.ts`、新 production-missing-secret fixture | chassis 当前可将 Core signing secret 回退为 portal identity secret | Web 同时使用两个独立 secret；缺失 portal secret 启动失败；错配 token 401 且不转发 Core |
| Docker profile and checks | `cli/test/config.test.ts`、`cli/test/check.test.ts`、`cli/test/secrets.test.ts`、`cli/test/docker-secrets.test.ts` | disabled profile 尚不能解析；Docker 仍要求 sandbox.app/PUBLIC_API_URL；core env 可覆盖 substrate | Docker-only disabled profile 产生正确 env，拒绝 override，无 Fly requirement，也不要求 PUBLIC_API_URL |
| Docker lifecycle | `cli/test/e2e/docker-lifecycle.e2e.test.ts`、`cli/test/e2e/harness.ts`、Docker backend focused unit tests | 当前端口暴露全部接口，ready 只看日志，fixture 没有真实 health endpoint | loopback publish、HTTP health gating、no socket bind、restart 和 non-purge volume proof 都通过 |
| durable live path | `test/custom-provider-route.test.ts`、`test/custom-provider-e2e.test.ts`、新的 Docker restart integration fixture | 当前没有全 Docker provider/runtime 的 down/up 后真实 call 证据 | Postgres 重启后仍可读出 provider/runtime，稳定 connector secret 下的后续 Pi call 成功或明确失败 |

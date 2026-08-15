# D0-L 验证与偏差记录

## 当前基线

- 当前 dev-instance 可作为混合本地 QA 证据：本机 Node 控制面、Docker Postgres 与本地 Docker sandbox，真实 Pi/custom provider 文本调用已验证。
- 它不是 D0-L 的全 Docker 验收：Core、Web、Admin 与 Portal 并未容器化。
- 现有 Docker backend 可启动容器化控制面，但默认端口未限制 loopback、Docker target 默认 harness 为 mock、production Core 要求显式 sandbox backend、现有 local sandbox 需要宿主 Docker 调用、Portal local auth bypass 不能通过 Docker bridge 安全使用。D0-L 需要新增 text-only disabled sandbox 契约、development health-only Portal、host-only dual-signed bootstrap 与文本验证器、healthz readiness 和两卷持久化验证。Portal 浏览器文本与 Admin 需要单独的 OIDC/TLS 身份拓扑和匿名边界设计，不能在本规格内假装已验证。
- Docker daemon 管理员可检查容器环境变量；D0-L 的 secret 边界不涵盖该管理员，而是禁止 Git、build context、镜像层、常规 CLI 输出和应用日志泄露。

## 全 Docker live 证据（2026-08-15）

### 构建身份

- Git HEAD `2fbfc00549444ac8cc3977d9e5c6ea9f9f50762d`，工作树 dirty（D0-L 增量未提交，属预期）。
- 镜像 content IDs：core `sha256:a52a9264633808d82d76a70042a126f5f31578e5e3c2ab88abfa9caa377813ff`、web-ui `sha256:d76ef642380582bfb36a2c868296571ab000c7e4ed8a94f2877c3ca2f6d9d1aa`、admin `sha256:92be4ed2cf7328f1830aeafde4dee6c378693868c9cda5efc741bcd67267e9b1`、portal `sha256:eabea9267616ca57586a2f31117061683aa8125c258f8051dcba445a51177328`；pg 为 release digest `sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20`（content `sha256:eb9fe6b5815523ffa3e3d8aee9db3532bd564b857634fcfa36979d76bed6ae10`）。
- 端口只发布到 `127.0.0.1`：core 19080、portal 19081、web-ui 19082、admin 19083；`[::1]` 无监听（CLI loopback 断言 + `[::1] not listening` 输出）。

### 真实文本 smoke（DeepSeek，经 Web → Core → Pi）

| runId | 文本 | 回复 | 阶段 |
| --- | --- | --- | --- |
| `ab6e32c3-7563-4309-b590-046bbcb8a773` | 只回复：DeepSeek local Docker smoke OK | DeepSeek local Docker smoke OK | 首次 up 后 |
| `d23949e0-3845-4cfb-9985-98a2fc114d45` | 只回复：core restart 后持久化 OK | core restart 后持久化 OK | `docker restart` 单服务后 |
| `a4c4d437-b6de-4043-b04b-a06a5823b60f` | 只回复：non-purge down/up 持久化 OK | non-purge down/up 持久化 OK | `qm down` + non-purge `qm up` 后 |

- `qm local bootstrap --principal local-admin --provider deepseek-local --protocol openai --base-url https://api.deepseek.com/v1 --model deepseek-v4-flash --context-window 128000 --max-tokens 8192`：成功。
- provider key 只从 0600 `.env` 的 `D0L_PROVIDER_API_KEY` 读取；命令、状态输出和日志未出现 key。

### 持久化证据（down/up 后从 Postgres 读出）

- `custom_model_providers`：`deepseek-local | openai | https://api.deepseek.com/v1 | DeepSeek`。
- `base_model_configs`：`{"modelId":"deepseek-v4-flash","scopeId":"org:local-deepseek","revision":1,"harnessId":"pi","orgRevision":1}`。
- `approved_harness_configs`：`{"ids":["pi"],"scopeId":"org:local-deepseek"}`。
- 卷：`qm-local-deepseek-pgdata` 与 `qm-local-deepseek-coredata` 在 `qm down` 后均保留；`qm down --purge` 未执行。
- runs/session 持久化：`runs` 3 行、`session_entries` 9 行（重启与 down/up 后累计保留）。

### 健康与生命周期

- `qm up --build-from`、`qm status`、`docker restart qm-local-deepseek-core`、`qm down`、non-purge `qm up` 全部可重复执行；每步后四个 loopback healthz（19080-19083）均 HTTP 200。
- `qm down` 只删除容器，保留两个命名卷。

## 偏差与修复记录

1. **镜像源 DNS 失败（原交接阻塞点）**：Docker Desktop registry mirrors（`docker.mirrors.ustc.edu.cn`、`mirror.ccs.tencentyun.com`）仍 NXDOMAIN，但 Docker 已回退官方 registry，`node:24-alpine@sha256:a0b9...` 与 postgres digest 拉取均成功。未重启 Docker Desktop，未中断其他容器。
2. **audit 门禁失败（新发现）**：`deploy/core/Dockerfile` 的 `npm audit --audit-level=moderate` 因本地分支清单文件落后于上游（`pi-coding-agent 0.82.0-security.2` 锁定 `undici 8.5.0`，在漏洞区间且无修复）而失败。对齐 `origin/main` 的 `package.json`/`package-lock.json`（security.3，undici 8.9.0 + hono/fast-uri/brace-expansion overrides）后 `npm ci` 报 0 vulnerabilities，构建通过。此修复只改两个清单文件。
3. **`defaultLoopbackHealthProbe` 挂起导致 `qm up` 退出码 13（新发现，CLI bug）**：首次 up 在 "starting core" 后以 Node 退出码 13（unsettled top-level await）终止。插桩证明 docker-proxy 在 core 尚未监听时 accept TCP 后干净关闭（connect → end/close，无 data/error/timeout），probe 的 promise 永不 settle，事件循环清空。修复：`cli/src/backends/docker.ts` 的 `defaultLoopbackHealthProbe` 增加 `close` 监听（`defaultIpv6Probe` 的 connect 先于 close 触发，close 监听不可达故不加），关闭连接按 unhealthy 结算并由 `waitReady` 重试。修复后 `qm up` 全程成功（EXIT=0）。回归测试：新增 `cli/test/loopback-probes.test.ts`（5 例：accept-close、200、503、closed port、IPv6 no-listener，覆盖修复前挂起的确切场景），相关测试 `cli/test/docker-local-baseline.test.ts`、`cli/test/check.test.ts` 50/50 通过。
4. **web-ui 启动瞬态失败（一次，未复现）**：non-purge `qm up` 一次在 `docker run qm-web-ui` 时 daemon 报 `No such container: b10be3dc...`；清理 build cache 后重跑成功。该镜像随后正常构建启动，未留下半配置容器，疑似 Docker Desktop 构建/运行竞态。若复现需进一步调查。

## Gate 记录

| Gate | 状态 | 说明 |
| --- | --- | --- |
| Gate 1 规格走查 | walkthrough-approved | 2026-08-14：独立 fresh-context 复审通过；direct disabled、text-only Pi、Web dual-secret、错误与恢复路径均已闭合。 |
| Gate 2 TDD | complete | 04-test-matrix 切片全部实现：config/text-only/disabled-sandbox/custom-provider/Web 双 secret/Docker lifecycle/durable live path；core 107/107、cli 120/120（含 loopback-probes 回归测试 5 例），typecheck 与 diff check 通过。 |
| Gate 3 漂移检查 | complete | 偏差均已记录并闭环：镜像源 DNS 失败（Docker 回退官方 registry）、清单对齐上游 security.3（undici 8.9.0）、probe 挂起修复（cli/src/backends/docker.ts + 回归测试）、web-ui 一次瞬态失败（未复现，已记录）。 |
| Gate 4 发布证据 | complete | 见下方独立评审与验收记录。 |

## 独立评审与验收记录（2026-08-15）

四路 fresh-context 独立评审（reviewer，只读，均未参与实现），每路覆盖一个切面；随后由实现会话补跑评审无法执行的测试：

| 切面 | 结论 | 关键证据 |
| --- | --- | --- |
| text-only 边界（src/core/text-only.ts、app-turn、orchestrator、pi-harness、wiring） | 无 blocker/major，7 项契约全部满足 | admission 在 enqueue 前拒绝非文本（runs 零创建）；snapshot 只含可解密 key + HTTPS；Pi 零工具定义、辅助调用全短路；历史投影只留纯文本 user/assistant；非 Pi harness 三层 fail closed；redirect:manual 在 buildApp 前安装且 307 不跟随 |
| disabled sandbox + model registry（disabled-sandbox.ts、wiring、config、custom-provider-store、server） | 无 blocker/major，路径 F 8 项契约全部满足 | profile 精确；wiring 窄化只建 disabled、零 router/migration/egress token；全方法 reject retryable:false；501/404 映射精确；terminal 判定共享且单次 claim；HTTP endpoint 在 key 验证前拒绝且零 fetch；PUBLIC_API_URL 非必填（config.ts:819 optional spread） |
| Web/Admin 身份边界 + F0 隔离（web-ui、admin、chassis、wiring、harness 路由） | 无 blocker/major，满足 D0-L 与 F0 规格 | Web 双 secret 独立注入、production 无回退（chassis 回退仅非 production）；token 校验/threadRef 绑定；bootstrap 不发送 x-admin-actor；Portal dev health-only 且 playground/bypass 拒绝；legacy harness/控制面路由 404（36 条路径断言） |
| CLI host bootstrap/verifier + docker backend（local-docker.ts、docker.ts、config、secrets） | 无 blocker/major，路径 A/B/C 契约全部满足 | loopback URL 严格校验（拒 localhost）；0600 非 symlink；双签名；三次 PUT 顺序与 body 精确；代理 env 三类拒绝；redirect manual + 有界超时 abort；成功判定要求 done+replyComplete+ok+非空 reply；端口仅 127.0.0.1 + IPv6 拒听；镜像证据 digest/HEAD+dirty；卷 non-purge 保留；D0L_PROVIDER_API_KEY 不入注入集；secret 分离断言 |

评审后处置（由实现会话执行）：
- signedPut 非 2xx 现在读取有界 error body 并带入错误消息（排障体验），新增测试 `local Docker bootstrap surfaces the Core error body with the failure`；cli 120/120 通过。
- `?d0l=` 随机 query 跨端契约确认：Core 端 canonical 用 `pathname + url.search`（src/api/server.ts:223）与 CLI 签名一致，admin 路由不校验 query，安全。
- 已知边界（不改动，记录）：secret 文件 lstat 与读取间 TOCTOU 且无 ownership 检查（本地 CLI 场景、0600 文件、同用户攻击面，规格只要求 0600 或更严格）；Web/Admin 在 production 缺失 PORTAL_IDENTITY_SECRET 时以每请求 401 启动而非字面拒绝启动（03-integration-errors 明确接受失败形状，CLI/Core 两层前置检查兜底）。

评审后测试补跑（评审者无 shell，全部由实现会话执行并记录）：core 107/107（含 f0-legacy-isolation 35/35、disabled-sandbox+custom-providers 44/44）、cli 120/120、web-ui 503/503、admin 80/80、typecheck、git diff --check。

真实 Docker 全栈验证在评审后重跑通过：`qm up --build-from` EXIT=0 四服务 ready，DeepSeek smoke run `6c184ea2` 回复匹配。

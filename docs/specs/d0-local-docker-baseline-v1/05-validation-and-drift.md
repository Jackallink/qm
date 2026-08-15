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
| Gate 2 TDD | complete | 04-test-matrix 切片全部实现：config/text-only/disabled-sandbox/custom-provider/Web 双 secret/Docker lifecycle/durable live path；core 107/107、cli 119/119（含新增 loopback-probes 回归测试 5 例），typecheck 与 diff check 通过。 |
| Gate 3 漂移检查 | complete | 偏差均已记录并闭环：镜像源 DNS 失败（Docker 回退官方 registry）、清单对齐上游 security.3（undici 8.9.0）、probe 挂起修复（cli/src/backends/docker.ts + 回归测试）、web-ui 一次瞬态失败（未复现，已记录）。 |
| Gate 4 发布证据 | in_progress | 自动化、真实 DeepSeek smoke×5、单服务 restart、non-purge down/up、持久化与 secret 边界证据齐全；本次改动（probe 修复/测试/清单对齐/验证文档）已过独立 fresh-context 评审（reviewer，无 blocker）。剩余：整个 D0-L 实现（工作树中其余未提交改动）的独立代码评审。 |

# F0 遗留实验面 Inventory

本 inventory 记录的是当前上游代码树中的研究资产与生产可达边界。它不证明任何私有部署、主机进程、外部 CI 或人工命令已经被清理；这些事实必须由相应部署项目保存运行证据。

| 类别 | 文件或路径 | F0 后状态 | 隔离证据 |
| --- | --- | --- | --- |
| 遗留 harness | `src/harness/prime-harness.ts`、`src/harness/hermes-harness.ts`、`src/harness/claw-harness.ts` 及 Prime RPC 辅助文件 | 未注册研究资产 | `src/wiring.ts` 不构造或导入这些 adapter；`HARNESS_IDS` 不接受其 ID；F0-01/F0-03 |
| 遗留运行时配置 | `PRIME_*`、`HERMES_*`、`CLAW_*` 环境输入和旧 runtime/approved-harness 持久记录 | 不可信输入，不进入当前 runtime | `loadConfig` 不产生遗留配置；解析只使用当前 ID、有效批准项或服务端 fallback；F0-01/F0-02 |
| Agent Registry、健康与 host launcher | `src/agent/agent-*.ts`、`src/agent/degraded-mode.ts`、`src/agent/registration-pipeline.ts`、`src/api/routes/admin/agents.ts` | **已重新接入（2026-08-16）** — wiring 构造 registry（PG 持久化），路由注册，admin-gated，live e2e 验证 | `agentRegistry` 暴露于 buildApp；f0 测试断言存在；审查修复（auth/状态机/注入）已合入 |
| SOP、消息与 Agent Scheduler | `src/agent/{sop,messenger,scheduler}-*.ts`、对应 `src/api/routes/admin/` handler | **已重新接入（2026-08-16）** — wiring 构造三个 store（PG 持久化），路由注册，admin-gated，live e2e 验证 | `sopStore`/`messengerStore`/`schedulerStore` 暴露于 buildApp；f0 测试断言存在；审查修复（auth/原子性/诚实化）已合入 |
| Emergency 与 dashboard | `src/api/routes/admin/{emergency,dashboard}.ts` | 未注册研究资产（有意保留——audit-only 空壳，违反"成功必须真实"纪律） | `adminRoutes` 不导入或匹配其 handler；F0-04 |
| Emergency 与 dashboard | `src/api/routes/admin/{emergency,dashboard}.ts` | 未注册研究资产 | `adminRoutes` 不导入或匹配其 handler；F0-04 |
| Agent Panel 与 proxy | `plugins/admin/public/agent-panel.html`，`/agents`、`/api/agents`、`/api/agent-templates` | 保留静态研究文件，HTTP 路径显式 `404` | 插件 HTTP test 断言无 core hop；F0-04/F0-05 |
| PC、Gateway 与辅助脚本 | `scripts/pc-agent.mjs`、`scripts/{ci-gateway,ci-p0-agent-registry,ci-p1-sop-engine,ci-p2-messenger,ci-p2-scheduler,live-verify-gateway}.sh`、Prime 相关构建或同步脚本、`local/Dockerfile.prime` | 手工研究资产，不属于 package script、路由或生产 wiring；Gateway 验证脚本预期只会命中 F0 后的 `404` | `package.json` 不注册它们；F0 不为其可执行性、配置安全或工作区外手工进程、外部 cron 作出声明 |

## 仍需部署侧完成的工作

F0 只能证明此代码树的静态可达性。部署项目在启用任何后续阶段前仍须保存以下证据：

1. 旧持久化 runtime 配置的备份与实际读取验证。
2. 现存 detached 进程、手工 PC 脚本或外部 CI 的盘点与受控终止记录。
3. 私有 runtime、网络、身份和治理接口的 D0/G0/X0 证据。

没有这些部署侧证据，F0 不能被误报为 Remote Turn、Agent、PC 或外部 adapter 已获准启用。

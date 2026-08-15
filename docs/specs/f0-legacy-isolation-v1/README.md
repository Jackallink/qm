# F0 遗留实验面隔离 v1

## 状态

`complete`。这是路线图 F0 的独立实现规格。它只隔离当前生产可达的遗留实验路径，不实现新的远程运行时、Agent 控制面或设备能力。

本目录包含三轮 walkthrough、AC 到测试映射、Gate 4 验证记录和独立审阅结论。完成仅证明本规格定义的隔离边界；不批准或启用任何后续运行时能力。

## 目标

确保正常 QM turn 只能使用已批准的非遗留 harness，且生产 HTTP/admin 表面不能调用尚未具备真实安全与持久化语义的 Agent Registry、生命周期、消息、调度、应急或面板功能。

F0 的完成不启用新的 Remote Turn。它仅使后续 D0、G0、X0 和 F1 能从可验证的安全基线开始。

## 范围

纳入：

- 从通用 harness 枚举、模型选择、运行时选择和 wiring 中移除遗留远程/外部 harness。
- 忽略遗留运行时环境配置；旧的持久化 runtime/approved-harness 记录必须优先解析为仍获批准的非遗留 fallback；若历史批准列表只剩无效 ID，则只能使用受服务端控制的非遗留部署 fallback；显式请求时拒绝。
- 解除 Agent Registry、生命周期、SOP、Messenger、Agent Scheduler、应急、dashboard 和 Agent Panel 的生产路由、公开 app 依赖与代理暴露。
- 移除管理插件的本地身份绕过；生产身份缺失时拒绝，而不是使用环境变量、默认用户或 cookie 降级。
- 用自动化测试固定上述不可达性，并回归一条正常、已批准的 QM turn 路径。
- 清理未注册研究资产中的 lint 基线问题；正常生产 wiring 不读取、传递或据此选择遗留 `PRIME_*` 配置。

不纳入：

- 删除研究代码、历史提交、开发脚本、镜像或私有部署资产。
- 实现 Remote Turn、Agent Definition、管理 UI、调度、消息、应急控制、PC/设备或外部 adapter。
- 迁移或删除旧持久化记录；本阶段只保证它们无法重新激活遗留执行。
- 修改既有通用 cron、普通 admin 功能、已批准的 `pi`、`opencode`、`codex`、`claude` 或 `mock` harness 行为。

## 安全不变量

1. 任意正常请求、请求体、持久化选择或环境变量都不能构造、选择或启动遗留 harness。
2. 任意遗留 Agent 控制面路径必须返回未路由结果；不能返回成功形状的占位响应。
3. 管理插件不存在生产本地身份绕过或默认主体；缺少受验证身份时不会转发到 core。
4. 正常批准的 QM turn 继续可用，且不会静默切换到遗留 harness。
5. F0 不依赖内存状态或隐藏 feature flag 作为隔离证明。

## 验收标准

| ID | 结果 |
| --- | --- |
| F0-01 | 遗留 harness ID 不是有效 `HarnessId`，不能经 web/API/配置选择；遗留环境选项不进入运行时配置。 |
| F0-02 | 在持久 runtime/approved-harness 记录包含遗留 ID 时，正常解析使用已批准非遗留 fallback；显式请求该 ID 被拒绝。 |
| F0-03 | `buildApp` 不构造或公开遗留 Agent Registry、SOP、Messenger 或 Agent Scheduler store，也不构造遗留 harness adapter。 |
| F0-04 | Agent Registry、生命周期、SOP、Messenger、Agent Scheduler、应急、dashboard 和 Agent Panel/core proxy 路径均不在生产路由表或管理插件中。 |
| F0-05 | 管理插件在生产签名身份缺失、伪造或过期时返回 `401`，不联系 core；测试模式的显式测试身份例外不扩展到生产。 |
| F0-06 | 一条正常、已批准的 QM turn 和既有通用 cron/admin 路由回归通过。 |
| F0-07 | 文档和 inventory 准确把遗留源文件/开发脚本标为未注册研究资产，而不宣称已删除或已实现后续能力。 |
| F0-08 | 全仓 lint 通过；正常生产 wiring 不读取、传递或据此选择遗留 `PRIME_*` 配置。 |

## 风险与回滚

风险是旧的已保存 runtime 配置、插件测试身份和正常 admin/turn 流被误伤。实现以移除可达 wiring/route 为主，不删除研究资产；若发现正常批准路径受影响，回滚本 F0 变更并保持所有后续 Remote Turn binding 禁用，直到缺口有新规格和测试。

## 关联记录

- [Round 1：用户故事与 AC](./01-user-stories.md)
- [Round 2：技术追踪](./02-technical-trace.md)
- [Round 3：集成与错误](./03-integration-errors.md)
- [AC 到测试矩阵](./04-test-matrix.md)
- [遗留实验面 Inventory](./05-legacy-inventory.md)
- [验证与偏差记录](./06-validation-and-drift.md)
- [路线图 F0/D0 依赖](../agent-platform-roadmap-v1/README.md)
- [F1 候选规格 Gate 0](../remote-turn-v1/README.md)

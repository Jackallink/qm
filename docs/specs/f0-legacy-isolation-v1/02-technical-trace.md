# Round 2 — F0 技术追踪

## 路径 1：正常 turn 的运行时解析

`正常 QM turn -> 服务端 runtime 解析 -> 已批准非遗留 HarnessId -> 已构造 adapter -> turn 结果`

遗留 ID 在枚举、请求验证和持久配置解析中均无效。旧持久化值进入普通解析时优先选择仍获批准的非遗留 runtime；若历史批准列表不含任何有效 ID，才使用受服务端控制的非遗留部署 fallback。它们不会构造或选择遗留 adapter；显式请求值收到正常的 runtime 拒绝。

## 路径 2：遗留控制面路由

`HTTP 请求 -> apiRoutes/admin plugin router -> 无匹配路由 -> 404`

Agent Registry、生命周期、SOP、Messenger、Agent Scheduler、应急、dashboard、Agent Panel 与其 proxy 不能进入 handler、store 或 host launch。既有通用 cron 与普通 admin 路由不在本路径中。

## 路径 3：管理插件身份

`管理请求 -> 签名 portal identity 验证 -> principal -> core source-auth forwarding`

生产环境只有验证通过的 identity 才会产生 principal。缺少或无效 identity 在插件本地得到 `401`，且不发送 core 请求。测试 cookie 仅在明确的测试环境开关下存在。

## 状态与持久化

本阶段不新增状态机或存储迁移。已有持久 runtime/approved-harness 数据被视为不可信输入：只允许有效的当前 `HarnessId` 参与 runtime 选择。F0 不改写该数据；后续阶段如需迁移，另立规格。

## 代码归属

核心应只保留通用隔离和验证逻辑。遗留 adapter/Agent 源文件、开发脚本和镜像可以保留为未注册研究资产，但不得由 core wiring、路由表、配置解析或管理插件引用。

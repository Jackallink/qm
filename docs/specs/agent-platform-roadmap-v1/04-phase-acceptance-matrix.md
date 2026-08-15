# 阶段验收矩阵

该矩阵是“终局目标 -> 能力 -> 阶段验收”的阶段摘要，不是逐项业务需求的单一事实来源。实际需求编号、外部系统合同、必达范围、量化目标和验收人必须由私有部署项目的[业务需求覆盖协议](./05-business-requirements-coverage.md)实例化；上游 core 不存放组织专属内容。

| 终局能力 | 阶段 | 最小验收用户故事 | 必需测试/演练 | 不能据此宣称的能力 |
| --- | --- | --- | --- | --- |
| 统一入口与遗留面收敛 | F0 | 正常用户不能意外进入实验性路径 | route/config/env/wiring inventory；正常 turn 回归 | 受信任远程执行、Agent 管理或运营控制 |
| 本地 Docker 可复现基线 | D0-L | 开发者在本机用全容器控制面完成真实文本模型与重启持久化验证 | local Docker lifecycle、loopback/secret 负测、真实文本 smoke、restart/down-up 演练 | 生产隔离、Kubernetes、HA、Remote Turn 或 agent execute |
| 合同与目标环境可行性 | D0-T | 交付负责人逐项确认需求、红线、目标环境和验收归属 | 私有逐项覆盖表；目标数据库/部署/网络/许可/HA/合规 proof 或批准差异 | 任一运行时、业务场景或量化指标已完成 |
| 指定入口与治理连接 | G0 | 已验证用户只能经指定入口发起受保护调用，并得到治理授权/审计回执 | 身份链、能力状态、原子鉴权、审批、trace/error/result、依赖失效 fail-closed contract tests | runtime 可执行、外部动作已获永久授权 |
| 参考运行时部署基线 | X0 | 一个固定参考 runtime 在目标环境中可安全调用、停止与回滚 | release/digest/workload identity/attestation/egress/termination/revoke canary | 其他 adapter、设备或升级路径已认证 |
| 受控远程执行 | F1 | 已授权用户收到一次受保护文本结果或真实拒绝/取消 | Remote Turn AC、目标数据库一致性测试、G0/X0 contract proof、abort/rollback canary | 流式、工具、文件、持久会话、后台 Agent |
| 受审核的 Agent 定义 | C1 | 发布者创建/归档版本化定义 | ACL/version/quota/CAS/restart/release rollback | 实例已在线、已调度或拥有任意能力 |
| 受控多回合交互 | C2 | 用户安全继续或中断同一会话 | isolation/stream/disconnect/recovery/cancel | 工具写入、跨会话 kernel、自治任务 |
| 模型、上下文与工作区治理 | M1 | 用户在授权模型和隔离上下文中工作，并可删除/审计状态 | model policy/QoS/usage/effect；context/memory/workspace ACL/TTL/delete/recovery | 任意模型选择、共享记忆或无边界文件访问 |
| 已授权 Skill、文档与动作 | A1 | 用户在审批边界内完成一项受限能力或指定文档/文件处理 | capability/policy/approval/artifact/input-output safety/secret/egress/compensation；public composition contract | Skill 市场、自动发布、无限制插件或自动回流 |
| 可恢复任务与接管 | T1 | 用户/审批人暂停、恢复、取消或接管长任务 | task/subtask/action-class retry/result/compensation/restart/handoff | 自主重试有副作用动作或通用 DAG 协作 |
| 协同与计划执行 | C3 | 授权 Agent/系统可靠处理消息或计划工作 | outbox/inbox/DLQ/idempotency/partition/catch-up/stop | 多 Agent 无限自治或无人工上限的常驻执行 |
| 真实运营控制 | O1 | 运营人员查看真相并完成逐目标停用、撤权、停止、会话阻断或策略回滚 | target-level disable/revoke/stop/session-block/policy-rollback/audit/analysis/backup/compatibility/UI security drill | 未经认证的管理页面或空操作应急接口 |
| 运行时与设备扩展 | X1 | F1 参考运行时之外的一个新 adapter 在限定 scope 内安全运行并停用 | adapter threat model/attestation/policy/upgrade/revoke/migration canary | 所有 adapter/设备/多组织已通用支持 |
| 端到端业务交付 | B1 | 业务用户完成私有覆盖表指定场景，并验证指定文档/文件范围、必达运行形态和量化目标 | requirements trace/business UAT/metrics/runbook/rollback | 其他未验收场景或全量企业覆盖 |

## 阶段开工检查

- [ ] 前置阶段 Exit Gate 已通过并有可访问证据。
- [ ] 新阶段有唯一 feature spec、三轮 walkthrough、AC 到测试映射和风险/回滚记录。
- [ ] 核心与私有部署层的归属已确定，没有把组织/供应商实现放入上游。
- [ ] 外部治理、身份、Skill 生命周期、设备或业务系统依赖已有 owner 和失败策略。
- [ ] 没有未处置的 P0/P1 安全、数据一致性或错误完成问题。

## 终局声明前检查

只有当业务需求覆盖表的每一个 `must` 项都链接到一个已完成阶段、可复验证据、验收人和回滚/运维材料时，才可以声明终局目标完成。任何尚未覆盖的运行时、设备、组织、业务场景或指标必须单独列为未完成范围。

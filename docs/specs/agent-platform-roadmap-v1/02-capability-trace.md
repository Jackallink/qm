# Round 2 — 能力与系统边界追踪

## 终局用户路径

以下是终局的逻辑追踪，而不是已注册的 API。每个阶段开始前，所属 feature spec 必须把涉及的路径细化为具体 Handler、状态、API、后端动作、响应和 UI 更新。

```text
指定入口
  -> 统一身份与 scope 决议
  -> 策略与外部治理授权
  -> 任务/会话与 Agent Release 决议
  -> 经认证的 runtime
  -> 已授权 Skill/工具/模型/终端能力
  -> 结果验证、产物与可信计量
  -> 状态、审计、告警与用户结果
  -> 停止、撤权、回滚或人工接管
```

任意箭头缺少服务端授权、耐久状态或可验证反馈时，路径不得被标为完成。

## 核心与部署层边界

| 层 | 可以承担的内容 | 不可以承担的内容 |
| --- | --- | --- |
| 上游 QM core | vendor-neutral 协议、状态机、持久存储契约、身份/授权接点、测试夹具、通用错误与审计接口 | 某个组织、入口、治理系统、模型供应商、设备、镜像、密钥或网络实现 |
| 私有部署层 | runtime/adapter 镜像、入口与治理连接器、设备策略、密钥引用、sandbox/egress 实施、运营 runbook、业务 UI/集成 | 绕过核心契约，或把组织细节回流到上游 core |
| 外部治理权威 | 身份、已授权能力状态、原子能力鉴权、高风险审批和审计接收 | 把未验证的平台代理行为当作授权事实 |

## 阶段技术追踪

| 阶段 | 进入路径 | 耐久状态与权威 | 成功输出 | 下一阶段的明确前置 |
| --- | --- | --- | --- |
| F0 基线与隔离 | 构建、配置、路由和正常 turn 清点 | 版本化 inventory、不可达测试、变更记录 | 遗留实验面不可从生产路径选择或构造 | 无隐式 legacy adapter/host launcher 可达 |
| D0-L 本地 Docker 基线 | 本机 Docker profile -> 容器化控制面 -> 文本模型与重启验证 | 服务清单、镜像标识、Docker 网络/卷、loopback 端口、健康和持久化记录 | 可重复本机全容器文本 QA；未验证 execute fail-closed | 不把混合 dev-instance 或本机 Docker 成功外推为生产、Kubernetes、HA 或 F1 证明 |
| D0-T 合同与目标环境可行性 | 批准需求 -> 私有覆盖表 -> 目标环境/依赖验证 -> 差异批准或阻塞 | 逐项需求归属、目标数据库/存储/网络/运行环境/许可/HA 证明、差异决定 | 每项需求有阶段、owner、证据与失败策略；目标环境可支撑后续契约 | 不能用开发依赖、单机或未验证数据库替代目标环境 |
| G0 指定入口与治理连接 | 指定入口 -> 服务端身份链 -> 治理授权/审批 -> trace/error/result/audit 回执 | 入口会话/身份验证、治理决定、能力状态、关联标识、回执与拒绝记录 | 每次受保护调用可验证地获授权或 fail closed | 不接受浏览器 header、环境变量或 runtime 自报身份/授权 |
| X0 参考运行时部署基线 | 固定 binding -> 私有部署控制器 -> attested workload -> 受控 egress/termination | release/digest、工作负载身份、attestation、令牌注入、网络和终止/撤权证明 | 一个参考运行时可被安全调用、停止和回滚 | 自报 digest、宿主进程或可旁路网络不能充当证明 |
| F1 受信任执行核 | 正常 text turn -> server-derived context -> G0 authorization -> X0 binding -> private runtime | 事务性 RemoteTurn、会话绑定、JTI/lease、预算/审计/回执/终止证据 | 一次受保护 final reply，或带证据的拒绝/park/cancel | 可证明一次执行、无未经证明的 egress/完成/取消 |
| C1 Agent 定义与发布 | 授权发布者 -> Definition/Release 审核和版本化 | 不可变 Definition/Release、owner/scope/ACL/quota、生命周期事件 | `registered` 或 `archived` 的真实定义记录 | 定义记录不等于在线进程；运行需要 F1 级执行证明 |
| C2 受控交互会话 | 已验证会话 -> 有序输入 -> runtime session | 每会话独立上下文、lease、流状态、断连/恢复/取消记录 | 可信多回合或带证据的中止 | 无 scope 共享 daemon、无内存会话真相 |
| M1 模型、上下文与工作区治理 | 已验证会话 -> 服务端模型策略 -> scope/session context -> 隔离工作区/记忆 | 模型策略/版本、路由/QoS/用量/效果记录、上下文/记忆/工作区 ACL、TTL、删除和审计 | 策略受控的模型回复与可说明的上下文生命周期 | 不能由用户、Agent 或 runtime 自选模型、共享记忆或保留越界文件 |
| A1 已授权动作、文档与产物 | 任务 -> capability -> 策略/审批 -> 工具、Skill、文件或文档处理 | capability token、审批决定、输入/输出安全结果、产物版本、密钥/egress、删除/补偿证据 | 可验证结果或明确失败/待人工处置 | 写入与外部动作不依赖运行时自述或无约束 retry |
| T1 持久任务与人工接管 | 用户/系统 -> task plan -> subtask -> action class -> result validator | 任务目标、计划、子任务、action class、失败节点、人工确认、补偿、结果验证 | 暂停/恢复/取消/接管与最终可解释结果 | 只读或已证明幂等动作才可限次重试/降级；写入或状态不确定动作必须 park、补偿或人工接管 |
| C3 协同、调度与常驻执行 | Release -> service identity -> message/job -> worker | outbox/inbox、idempotency、DLQ、lease、schedule、catch-up、终止证明 | 交付/处理状态可追溯、可停止、受预算限制 | 入库不等于送达/执行；定时表达式不等于调度服务 |
| O1 运营、合规与管理面 | 管理员 -> authenticated control API -> target actions -> audit/read model -> UI | 授权、目标清单、逐目标 disable/revoke/stop/session block/policy rollback 证据、告警、实时通知/分析、备份/恢复和升级兼容记录 | 真实控制结果和一致的只读运营视图 | 页面/API 不能伪造成功或绕过安全语义 |
| X1 Adapter 与企业部署认证 | F1 参考运行时之外的 Adapter/设备注册 -> attestation -> policy binding -> controlled runtime | adapter release、设备/工作负载身份、隔离/egress 证明、撤权/升级事件 | 一种新增运行形态在限定 scope 内可安全运行/停用 | 每种 adapter 是独立信任边界，不继承默认信任 |
| B1 业务场景与终局验收 | 受选业务流程 -> 已授权能力编排 -> 用户/审批/运营闭环 | 需求覆盖、业务结果、trace、指标、用户反馈、回滚演练 | 可复验端到端业务结果与验收结论 | 技术子模块不能替代场景验收 |

## 关键依赖和禁止跳跃

1. F0 在所有新功能之前：遗留可达路径会使任何后续安全证明失效。
2. D0-L 在本机 Docker 验证之前：全容器控制面、真实文本模型和重启持久化必须可重复；它不声明生产部署能力。
3. D0-T 在任何远程执行或目标环境宣称之前：后续能力必须知道目标存储、部署、网络、许可、合规和量化验收能否满足，或已有批准差异。
4. G0 和 X0 在 F1 之前：指定入口/治理授权和参考运行时的物理执行证明必须同时成立；两者缺一即拒绝远程执行。
5. F1 在 C2、M1、A1、T1、C3 和 X1 的执行启用之前：后续能力不可把不确定的远程执行当作可靠基底。
6. C1 先提供“定义与发布记录”，但不得带来 host spawn 或假运行状态；任何运行实例必须引用经认证的 runtime binding。
7. M1 在 A1 的跨回合上下文、记忆和工作区依赖之前；A1 在 T1/C3 的写入和副作用之前。任务、消息或计划执行不能成为绕过模型策略、capability、审批、产物账本和 egress 的捷径。
8. T1 在自主协作、补跑、常驻执行和业务签收之前：无 durable task/recovery 语义时，自动化只能造成重复或不可解释的副作用。
9. O1 的控制 API、审计模型和真实动作在 UI 之前；UI 仅投射已验证的后端真相。
10. X1 的每一种新增运行形态均单独认证；公开共享、多组织、跨集群和跨地域需要独立的数据主权与授权模型，不能由单组织证据外推。

## Round-2 批准条件

每一阶段都有唯一 owner、核心/私有层归属、输入、耐久状态、真实输出和前置证据。若某一条需要尚未确定的外部协议，路线图只能写明接口责任和阻塞条件，不能虚构 API 或把它标为可实现。

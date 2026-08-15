# 自定义模型 Web 选择器 v1

## 状态

`complete`。本规格修复已注册的通用自定义模型在 Web UI 模型菜单中被客户端过滤、但 Web turn 准入仍拒绝的问题；并发写入、跨实例刷新与本地 live 回归均已完成。

## 目标

管理员通过既有 Custom providers 表单注册并启用一个模型后，正常用户能在服务端允许的 harness 下看见、选择并使用该模型。Web UI 只把服务端已批准的模型目录用于显示；模型密钥和实际请求仍由 core 处理。

## 范围

纳入：

- 将服务端 runtime config 中的通用自定义模型元数据（名称、provider、协议类型）转成 Web UI 的显示模型。
- 在没有显式 Web 模型清单时，让 Web turn 的服务端准入使用与 runtime config 相同的、按 harness 过滤后的模型目录。
- 以原子写入保证自定义 model ID 在 enabled provider 中唯一，并在每个模型选择边界从 durable store 刷新 registry。
- 拒绝与 QM registry 或 Core 管理 provider 的模型 ID 冲突的自定义 model ID，并将旧的冲突记录从运行时目录中隔离。
- 为新 provider 保留 Pi 内置 provider slug；现有同名持久记录不自动停用或改写。
- 让 OpenAI-compatible 的 DeepSeek 模型别名保留 Pi 已知的推理与工具续轮协议，同时仍使用该别名自己的 URL 和 key。
- 保留当前 built-in、clone 和 OpenRouter 模型行为。
- 用 Pi + 一个 OpenAI-compatible 自定义模型覆盖默认选择和菜单显示；mock 仅用于自动化测试。

不纳入：

- 新增模型提供商、密钥存储、模型协议、工具调用或推理配置。
- 改变 runtime-config 的鉴权语义、审批、预算、egress 或实际模型请求。
- 把客户端未知 ID 当成可调用模型。
- 让 OpenCode 使用自定义模型；其常驻 sidecar 在启动时固定 provider 配置，安全的热更新属于独立规格。

## 安全不变量

1. 浏览器只信任 core 返回的 `modelsByHarness` 和 `modelCatalog`；不能凭用户输入构造任意 provider/model。
2. 自定义模型的 API key、base URL 不进入 runtime config、Web bundle 或测试输出；仅传递无密钥的协议类型。
3. Web UI 的显示模型不承担请求路由权威；core 继续校验 harness、模型和 provider key。
4. 一个自定义 model ID 必须唯一解析到其已注册 provider；与另一个 custom provider、QM registry 或 Core 管理 provider 冲突的 ID 不得进入目录、运行时或 turn 准入。
5. 新 provider 不得使用 Pi 内置 provider slug；自定义别名可使用 Pi provider-scoped model ID，例如 `deepseek-local/deepseek-v4-flash`。旧同名 provider 仅保持兼容，不自动迁移。
6. provider 写入在共享 advisory lock 内完成冲突检查和持久化；每个新 turn、runtime/surface 配置读取与 Pi 模型工具在解析模型前刷新 durable registry。相同 snapshot 不改变 registry version；OpenRouter 目录刷新失败时仍合并当前 custom registry。
7. 已有 write-only API key 只能在相同 protocol 与 base URL 的元数据更新中保留；更改 endpoint 或 protocol 必须重新提交 key，避免旧 key 被送往新地址。提交 key 的 endpoint validation 不跟随 3xx，任一重定向都作为验证失败，不能把 protocol-specific key header 送到另一 origin。
8. 每次 Pi execution 从同一 durable provider snapshot 解析 model、models.json 与 custom key；Core 管理 provider slug 的旧记录被过滤，in-flight execution 不得混用旧 URL 与新 key，删除的请求 custom model 不得静默回退。持久 Pi selection 在 router 的短暂 registry 失配中交给该 snapshot 解析或拒绝，不得降级为内置模型。
9. OpenAI-compatible DeepSeek 别名复用 Pi 对该模型 ID 的静态推理、thinking 与 tool replay 语义，但不复用 Pi 的 provider slug、URL 或 key。

## 验收标准

| ID | 结果 |
| --- | --- |
| CPW-01 | `pi` 的 runtime config 同时含有自定义模型 ID 和对应 catalog 元数据时，Web 模型菜单显示该模型并将其作为有效默认值。 |
| CPW-02 | 自定义模型的显示对象保留服务端给出的 ID、名称、provider 和协议类型；不会把它伪装为 OpenRouter 或错误协议。 |
| CPW-03 | 无 catalog 元数据的未知 ID 仍被过滤并使用已有 fallback；内置与 OpenRouter 行为不变。 |
| CPW-04 | 本地 Admin 注册 → Governance 选 `Pi + custom model` → 新 Web 对话可选择该模型；无显式 Web 清单时，core 接受该服务端目录中的 Pi 模型并由既有 custom-provider 路径发送。 |
| CPW-05 | 管理员注册与另一个 custom provider、QM registry 或 Core 管理 provider 模型 ID 冲突的模型时收到拒绝；即使旧持久记录存在，该 ID 也不会出现在 runtime config 或获得 custom-provider 准入。 |
| CPW-06 | 两个并发 provider 写入认领同一 model ID 时恰一个成功；其他实例或过期进程 registry 在下一次模型选择前从 durable state 刷新，删除和变更不会依赖重启，即使 OpenRouter 目录暂时不可用。 |
| CPW-07 | 自定义模型仅能被 `pi`（和 mock 测试）选择；`opencode` 不能展示、保存或执行自定义模型。 |
| CPW-08 | 更改已有 provider 的 protocol 或 base URL 时必须提交新的 API key；keyless 元数据更新仍保留既有 write-only key。endpoint validation 对 3xx 失败而不跟随重定向。 |
| CPW-09 | Pi turn 与 async 模型工具在 provider 并发更新时使用一致的 URL/key snapshot；删除的请求 custom model 在网络请求前失败，不回退到内置模型。 |
| CPW-10 | `deepseek-local/deepseek-v4-flash` 这类 OpenAI-compatible 别名在推理工具续轮中发送 DeepSeek 所需的 `thinking`、`reasoning_effort` 和 assistant `reasoning_content`，同时仍使用 custom endpoint/key。 |

## 风险与回滚

风险是客户端展示模型的 provider 元数据与 core 目录不一致，或管理员更新 provider 时实例使用过期 registry。实现仅在已有 core catalog 已明确提供元数据时生成一个 UI 显示模型，并在模型选择边界从 durable store 刷新。若回滚，删除客户端 fallback、禁用自定义模型选择即可；不会自动改写已保存的 provider 或 runtime selection。现有使用 Pi provider slug 的记录需在单独迁移中显式改为别名，不能由本规格自动修改。

## 关联记录

- [Round 1：用户故事与验收](./01-user-stories.md)
- [Round 2：技术追踪](./02-technical-trace.md)
- [Round 3：集成与错误](./03-integration-errors.md)
- [AC 到测试矩阵](./04-test-matrix.md)
- [验证记录](./05-validation.md)

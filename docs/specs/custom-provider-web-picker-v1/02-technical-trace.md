# Round 2 — 技术追踪

## 路径：已注册自定义模型进入 Web 对话

`Admin 保存 provider -> shared advisory lock 内检查并写 durable store -> 本实例刷新 custom provider registry -> 管理员保存 Pi + model runtime selection -> Web GET /api/runtime-config 刷新 durable registry -> modelsByHarness + modelCatalog -> applyRuntimeOptions -> buildOption -> Web 菜单/默认模型 -> 用户发起 turn -> core 与 router 刷新 registry 后用相同按 harness 过滤的目录校验模型 -> Pi 在解析模型前再次刷新 -> custom-provider dispatch`

`modelCatalog` 是服务端提供的名称、provider 和协议类型元数据。客户端只在模型 ID 同时位于选定 harness 的 `modelsByHarness` 中且拥有该元数据时构造显示模型。该显示模型使用与协议匹配的已有客户端模板承载 UI 所需的 `Model` 形状，并覆盖 ID、名称、provider 和协议类型；它不创建客户端网络调用。

## API 与持久化

本修复不新增 API 或表。

- 读取：`GET /api/runtime-config?scopeId=<scope>`。
- 已有选择写入：`PUT /api/runtime-config`，请求体 `{ "scopeId": "personal:<actor>", "harnessId": "pi", "modelId": "<custom-id>" }`。
- org default 已有写入：`PUT /api/scopes/org:<org>/runtime`，请求体 `{ "harnessId": "pi", "modelId": "<custom-id>" }`。

持久 runtime selection、provider 密钥和模型 registry 均保持在 core 的既有 durable store 中；Web UI 不新增持久状态。

没有显式 Web 模型清单时，turn handler 从 core 的 built-in 加已注册 custom provider catalog 中取得当前 harness 可用的模型；有显式清单时，清单继续是更严格的授权边界。浏览器传入的 ID 不能改变该服务端选择或绕过 provider 可用性检查。

provider 写入在共享 advisory lock 内检查每个自定义 model ID 是否已属于另一个 enabled custom provider，或与 QM registry、Core 管理 provider 模型冲突并拒绝。新 provider slug 同时不能与 Pi 内置 provider slug 冲突。运行时加载会再次过滤旧持久记录中的模型 ID 冲突和 Core 管理 slug（`anthropic`、`openai`、`openrouter`），随后才构造 custom registry、provider key 集合和 models.json，因此旧数据也不能把请求路由到错误提供商或覆盖系统托管凭据。

自定义 provider 的 model ID 是 provider-scoped：`deepseek-local/deepseek-v4-flash` 合法，且 Pi runtime 使用 `deepseek-local` 的 URL 与 key。现有 active `deepseek` 同名持久记录保持兼容，可原地提交新 key 或 metadata 更新，但删除后不能重新创建；后续改名须单独迁移。Core 管理 slug 的旧记录不享有该兼容例外。`setCustomProviders()` 会比较无密钥 snapshot，未变化时不增加版本、不使 picker catalog 重建。OpenRouter 目录请求失败时，catalog 保留已知动态 OpenRouter 项并重建 built-in 与当前 custom 项，不能保留过期 custom 项。OpenCode 不纳入本规格：其 sidecar 在启动时冻结 provider 配置，因此 `modelSupportedByHarness()` 对 custom ID 只允许 Pi 和 mock。

在 shared lock 内，store 比较已有记录的 protocol 与 base URL。若存在 encrypted key 且调用方未提供新 key，则只允许这些 endpoint 字段保持不变；否则拒绝写入且保留旧记录。这样 keyless 的名称/模型清单编辑继续可用，而 endpoint 变更无法将 write-only key 发往新 URL。提交新 key 的 validation request 使用 `redirect: "manual"`；3xx 返回验证失败，不能使 OpenAI bearer 或 Anthropic `x-api-key` 跨 origin 转发。

每个 Pi turn 或异步模型工具先刷新 durable registry，再在同一个 custom-provider lock 内读取 enabled spec 集合并解密其中匹配的 key，得到不可变 provider snapshot。该 snapshot 同时解析请求 model、生成该次 execution 的 models.json，并提供 custom provider key；托管 Anthropic、OpenAI、OpenRouter key 与 custom key 分开取得，不能相互覆盖。更新发生在 snapshot 取得后时，in-flight execution 继续使用旧 URL 与旧 key；更新发生在 snapshot 取得前时，新 execution 使用新 URL 与新 key。请求 model 不在该 snapshot 时，在创建网络请求前返回 `Unsupported model`，不能回退到创建 session 时的默认模型。持久化 Pi selection 即使在 router 的进程 registry 与 durable snapshot 短暂不同步时也保留原 model ID 交给 Pi snapshot 解析；snapshot 不含该 ID 时拒绝，不能改成内置默认值。

`toRuntimeModel()` 对 OpenAI-compatible custom provider 的 model ID 查询 Pi 的内置 DeepSeek 静态模型描述。命中时仅复制 `reasoning`、`compat` 和 `thinkingLevelMap` 到该 custom runtime model 与 snapshot 的 `models.json`；custom provider 自己仍提供 provider slug、base URL、key、名称、窗口和计量。pi-ai 因而按 DeepSeek 格式发送 thinking/reasoning 参数，并在带 tool history 的 assistant replay 中填入 `reasoning_content`。

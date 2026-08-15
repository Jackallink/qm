# Round 3 — F0 集成与错误处理

| 条件 | 对外结果 | 证据 | 不允许的结果 |
| --- | --- | --- | --- |
| 请求指定遗留 harness | 正常 runtime 拒绝 | 请求验证测试；无 adapter 调用 | 静默切换到遗留 adapter |
| 持久配置含遗留 harness | 使用当前批准的非遗留 fallback；若历史批准列表全失效，使用受服务端控制的非遗留部署 fallback | runtime 解析测试 | 构造或执行遗留 adapter |
| 请求遗留 core 路径 | `404 not_found` | route-table/HTTP 测试 | `200`、`202` 或伪操作结果 |
| 请求 Agent Panel/proxy | `404 not_found` | 插件 HTTP 测试 | 渲染面板、转发到 core |
| 生产请求缺失/伪造 portal identity | `401 signed_out`，无 core hop | 插件 fake-core 测试 | 环境默认主体、cookie 或 header 升权 |
| 正常非遗留 turn | 维持现有成功/拒绝语义 | 回归测试 | 因 F0 发生无关失败 |

## Stop 条件

任何遗留 adapter 仍可由请求、环境、持久化配置或 wiring 到达；任何遗留控制路径仍匹配；或管理插件在生产身份缺失时转发请求，均阻止 F0 完成和任何后续阶段启用。

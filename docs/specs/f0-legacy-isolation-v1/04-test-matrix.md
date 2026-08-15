# F0 验收标准到测试矩阵

| AC | 红测试与完成测试 | 初始位置 |
| --- | --- | --- |
| F0-01 | 遗留 ID 不在 `HARNESS_IDS`、`isHarnessId` 为 false、显式请求被 runtime resolver 拒绝；遗留环境变量不生成 config 字段 | `test/f0-legacy-isolation.test.ts` 的 legacy-ID 测试；`test/runtime-selection.test.ts` 的 explicit unapproved-request 测试 |
| F0-02 | 含遗留 runtime/approved-harness 的内存和 durable 解析选择已批准非遗留 fallback；历史批准列表仅含遗留 ID 时使用服务端 fallback；无遗留 adapter 调用 | `test/f0-legacy-isolation.test.ts` 的 persisted-selection 与 wiring-sentinel 测试；`test/runtime-selection.test.ts` |
| F0-03 | `buildApp` 的公开依赖中没有遗留 store；正常 harness adapter 集合不依赖遗留构造 | `test/f0-legacy-isolation.test.ts` |
| F0-04 | 所有枚举的遗留 core 路径在 `apiRoutes` 和真实 HTTP 中为未路由；插件 `/agents`、`/api/agents/*`、`/api/agent-templates` 为 404 | `test/f0-legacy-isolation.test.ts`、`plugins/admin/test/legacy-agent-panel-disabled.test.ts` |
| F0-05 | 生产环境缺失/伪造/过期 identity 为 401 且 fake core 未收到对应管理请求；缺少专用 identity secret 同样 fail closed；明确测试开关保留测试 cookie 路径 | `plugins/admin/test/production-identity.test.ts`、`plugins/admin/test/production-identity-missing.test.ts`、`plugins/admin/test/whoami.test.ts`、`plugins/admin/test/grants.test.ts` |
| F0-06 | 已批准 normal turn、route-auth contract、generic cron 及普通 admin proxy 回归通过 | `test/f0-legacy-isolation.test.ts` 的 normal-turn 测试、`test/runtime-selection.test.ts`、`test/route-auth-conformance.test.ts`、`test/cron-store.test.ts`、`test/cron-scheduler.test.ts`、`plugins/admin/test/grants.test.ts` |
| F0-07 | F0 inventory 与路线图不把未注册研究资产描述为已删除或已启用 | 文档审查与独立审阅 |
| F0-08 | 全仓 lint 基线通过；正常 production wiring 不读取、传递或据此选择遗留 `PRIME_*` 配置 | `npm run lint -- --quiet`；F0-01 配置与 wiring-sentinel 测试；文档与独立审阅 |

先运行 F0 新增测试并确认其在基线失败；实现后运行受影响的 root/plugin 测试、`npm run typecheck`、`npm run lint` 和独立新鲜上下文审阅。

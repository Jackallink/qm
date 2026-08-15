# F0 验证与偏差记录

## 实现边界

F0 移除遗留实验面的生产 wiring、配置、路由和代理，并进行不恢复可达性的 lint 基线清理。保留的 harness、Agent、Gateway 与 PC 源文件仍是未注册研究资产；本阶段不启用或使它们可手工运行。

`ServerDeps` 仍保留四个 legacy store 的可选类型字段，仅使未注册研究 handler 保持可编译；标准 wiring 不提供这些字段，公开 `AppDeps` 和 `buildApp` 返回值也不公开它们。删除这类研究文件或把它们移至独立包，应由后续、专门的清理规格处理。

## Gate 4 结果

F0 于 2026-08-13 完成其定义的 release gate：

- `node --experimental-test-module-mocks --test --test-reporter=dot test/f0-legacy-isolation.test.ts test/runtime-selection.test.ts test/route-auth-conformance.test.ts test/cron-store.test.ts test/cron-scheduler.test.ts`：92 项通过。
- `npm --prefix plugins/admin test`：80 项通过。
- `npm run typecheck` 与 `npm --prefix plugins/admin run typecheck`：通过。
- `npm run lint -- --quiet` 与 `git diff --check`：通过。
- 最终独立新鲜上下文审阅未发现 P0/P1；生产 identity 测试在禁用测试隔离时可能共享模块环境的 P2 测试卫生问题不阻塞 F0。

作为额外信号运行的完整 `npm test` 不属于 F0 的受影响测试集，并受到当前 shell `PAGER=less` 的既有环境假设影响：`test/sandbox-noninteractive.test.ts` 期望未设置的 pager 默认值。清空该组环境变量后，该文件 4 项通过。该基线问题未在本规格中修改，也不构成 F0 可达性、身份或正常 QM turn 的失败。

F0 的 release gate 要求全仓 lint 通过。基线清理只能删除无效代码、修复 ESM 或收敛未注册 source 的默认值；不得恢复遗留路径、增加测试绕过、添加 lint ignore 或让研究资产重新成为生产能力。手工研究脚本的可执行性、环境安全和工作区外进程处置仍属于部署侧盘点，不是 F0 的完成声明。

## 后续阶段边界

F0 验证不构成 D0、G0、X0 或 F1 的通过证据。尤其不能从路由隔离推导出目标环境、治理接口、attestation、强制 egress、运行时终止或预算结算已经可用。

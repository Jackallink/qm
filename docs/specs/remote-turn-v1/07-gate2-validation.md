# Gate 2 验证记录 — Remote Turn v1 上游通用扩展

## 状态

Gate 2（上游通用扩展）实现完成，red-test-first；本记录为验证与偏差存档。Gate 2 完成签核仍待 D0-T/G0/X0 证据（规格 README Status）。

## RTH 到测试文件映射

| RTH | 验证点 | 测试文件 | 状态 |
| --- | --- | --- | --- |
| RTH-02 | binding 版本化 enable/disable CAS，无浏览器/header 回退 | `test/remote-turn-binding.test.ts` | pass |
| RTH-03 | G0 拒绝：缺失/过期/错配治理上下文 typed-denied，无 admission/reservation/JTI | `test/remote-turn-store-pg.test.ts`（governance mismatch、remote_run_exists、concurrent remote_turn_active） | pass |
| RTH-04 | 文本/历史/输入界在 dispatch 前强制；reply 大小在 receipt 处强制（RTH-10）；运行时长在 sweeper 处强制（RTH-11） | `test/remote-turn-store-pg.test.ts`（bounds in admit）；`test/remote-turn-receipt-budget-teardown.test.ts`（reply bound）；`test/remote-turn-reconciler-pg.test.ts`（runtime ceiling） | pass（partial：见偏差） |
| RTH-05 | 原子 admission（session 绑定 + RemoteTurn + audit + reservation 单事务）；crash 无残留；pre-dispatch 过期释放 | `test/remote-turn-store-pg.test.ts`（onStep crash、all-artifacts-absent）；`test/remote-turn-recovery-pg.test.ts`（expirePreClaim/expireAdmissions） | pass |
| RTH-06 | 真实 Postgres Session.id 事务绑定；`remote_turn_active` 拒绝第二输入；restrict-delete 防删 | `test/remote-turn-store-pg.test.ts`（concurrent admission）；`test/run-store-remote-once.test.ts`（deleteSession + forceReleaseLease holder skip） | pass |
| RTH-07 | turn/abort token JTI、capability、kid、skew、claim 单次消费、abort-before-claim | `test/remote-turn-token-abort.test.ts` | pass |
| RTH-08 | pre-claim attestation / start proof 验证契约（fake attestor + jose 真签名）；planned-vs-actual mismatch → park | `test/remote-turn-attestation-transport.test.ts` | pass（partial：见偏差） |
| RTH-09 | remote-once 不 requeue；pre-claim restart 只重发持久化 envelope；post-claim restart reconcile/park | `test/remote-turn-recovery-pg.test.ts`（cross-instance、partial unique、resume guard）；`test/remote-turn-reconciler-pg.test.ts`（reconcile paths） | pass |
| RTH-10 | receipt 验证 + trusted usage 结算 + teardown 完成；same-transaction run 写回触发 onTerminal | `test/remote-turn-receipt-budget-teardown.test.ts` | pass |
| RTH-11 | 授权 abort/timeout/disable → cancel_requested；终止证明后才 cancelled；60s 上限 sweeper | `test/remote-turn-reconciler-pg.test.ts`（abort-holds-resources、terminateTurn、runtime ceiling、disable outcomes） | pass |
| RTH-12 | 每错误 typed outcome + 持久证据 | `test/remote-turn-error-contract.test.ts` | pass |
| RTH-13 | 授权审计读只暴露本 scope 链，跨 scope not_found，记录 denied | `test/remote-turn-audit-read-pg.test.ts` | pass |

## 执行验证

- 全部 remote-turn pg 套件（含 run-store-remote-once、persistence-pool-registry）：125/125 pass（`--test-concurrency=1`，真实 Postgres）。
- 更广 pg 套件（run/session/audit/budget/replay/registry）：79/79 pass。
- `npm run typecheck`：clean。
- `git diff --check`：clean。

## 偏差与部分覆盖

1. **RTH-04 envelope 负例部分覆盖**：输入/历史界在 admit 强制；attachment/tool/path/credential/binary 输入拒绝属 Gate 3 surface（真实 turn 入口不在 Gate 2）。
2. **RTH-08 transport 负例部分覆盖**：core 契约测试覆盖签名/密钥/digest/nonce/workload/planned-vs-actual；unregistered service 与 DNS/cert/SAN 的 transport resolver 负例无 Gate 2 任务（无 transport resolver，Gate 3）。
3. **RTH-06/11 测试文件折叠**：矩阵原定 `remote-turn-session-binding-pg.test.ts` 并入 `remote-turn-store-pg.test.ts`（Task 5）；`remote-turn-cancellation.test.ts` 并入 `remote-turn-reconciler-pg.test.ts`（Task 11）。
4. **真实 turn-flow 接入点留 Gate 3**：Gate 2 的 `admit()` 由 pg 测试直接调用；app-turn 分支 / G0-presence 路由属 Gate 3。
5. **`REMOTE_TURN_SIGNING_KEY` 装配留 Gate 3**：Gate 2 使用注入的 fixture provider（`RemoteTurnKeyProvider`），部署层 env 装配未接线。
6. **`reconciler` 无生产 wiring**：`errors`（Postgres ErrorLog）与 sweeper 启动由 Gate 3 接线；Gate 2 仅测试直调 `sweep()`。
7. **拒绝 admission 的审计可见性**：refused 事件按 run id 持久（RTH 硬不变量 10），但 `readAuditChain` 的 scope JOIN 只覆盖已 admission 的 turn 链；pre-admission 拒绝行可按 run id 直接查 `remote_turn_events`，如需进审计读需新增 scope 字段或独立拒绝表（留 Gate 3 决策）。
8. **reconciler 的 `parked → failed` 依赖 attestor 查询**：无 sandbox/lease 消耗的证明来自 `AttestorGateway.querySandboxState`；Gate 3 提供真实 attestor 后该路径才能端到端。

## 残余风险

- `expirePreClaim`/`expireAdmissions` 的 `now` 参数仍用于测试注入，生产路径以 DB 时钟为准；应用时钟与 DB 时钟的边界秒漂移已消除于判定，但注入参数保留兼容。
- claim 的 `claim_expires_at` 以 DB 时钟 + binding max_runtime_ms 写入；sweeper 以 DB 时钟判定。
- FK 约束在绑定/审计 store 的独立 DDL 列表中以 `to_regclass` 守卫，表存在时才应用；首次建库顺序由 store 的 DDL 数组保证。

## 多专家实现走查修复记录（2026-08-16）

四路 fresh-context 专家对已实现代码走查（存储/事务、协议/安全、QM 集成、测试），发现并修复：

Gate 2 内修复（8 commits）：
- claim CAS 强制 pre_claim_expires_at（90s 期限 TOCTOU 消除）
- admit 持久化完整 request（deliveryTarget/surface）——远程回复可经标准 delivery 路径投递
- wiring 注入生产 run store——completeOn/failOn 的 onTerminal 链真实触发
- listOrphanRuns 纳入 pending + 过期 lease——admit 崩溃窗口孤儿行可回收
- session lease 续租 + acquireLease 跳过 remote_turn: holder——parked turn 租约不丢
- 终态行 detach（qm_session_id→NULL）+ terminateTurn 强制 TerminationEvidence
- prepareDispatch 拒绝已 abort 的 admitted turn
- turn/abort claims schema pattern 强制（uuid/64-hex/minimums/jti minLength）

记录为 Gate 3 backlog（不阻塞 Gate 2）：
- settle() 在 COMMIT 前触发监听器（竞态窗口小，Gate 3 wiring 复核）
- pool refcount 泄漏（wiring stop 补 remoteTurnStore.close()）
- denial audit 事件孤儿化（readAuditChain 需并入）
- KeySetEntry.state 冗余于时间窗、abort token exp 硬编码 90s、attestation_nonce_hash 不绑 CAS

验证：132/132 remote-turn pg 套件 + 全量回归 + typecheck + diff-check 全绿。

# Gate 1 走查批准记录

## 状态

**walkthrough-approved** — 2026-08-15。Gate 1 批准条件（contract、状态机、控制流程、错误矩阵、威胁模型、AC-to-test 矩阵、程序前置证据引用）经独立 fresh-context 评审逐项核对成立，无 blocker。批准附带三个条件，均在本记录中闭环。

## 评审结论

- 状态机三源一致：README 状态机段 / 02 allowed-transitions 表 / 03 错误表，全部 15 个状态（created、session_bound、admitted、dispatching、claimed、executing、reply_received、teardown_pending、cancel_requested、parked、completed、rejected、failed_pre_dispatch、failed、cancelled）逐状态核对无矛盾；claim guard 与 parked/cancel 来源集逐字一致。
- 错误契约完备：03 全部 21 行错误均有具名 owner、typed outcome、durable evidence、映射测试 ID。
- Schema 规范：05-protocol-schema.md 的 7 个 JSON Schema 抽查合法（draft 2020-12、additionalProperties:false），与 README/02 字段清单一致。
- 威胁模型、测试映射、Gate 0 隔离范围核对成立。

## 批准条件闭环

1. **存储修订条款（major，已消解）**：README Status 段现已显式声明——draft 的 D0-T 前置已按其自身修订条款执行，存储设计为命名的 PostgreSQL 参考 profile（当前 QM session 原语即 PostgreSQL 系），并经多专家走查与本 Gate 1 评审重新审计。D0-L 提供本机 Docker/Postgres 持久化证据（`../d0-local-docker-baseline-v1/05-validation-and-drift.md`）。D0-T 的剩余角色降级为"证明目标环境与该 profile 匹配"；不匹配才需再次修订并重新审计。Architecture decision 与 Phase order step 2 已同步改写。
2. **Owner 同意记录**：
   - Upstream 通用扩展 owner（对交易/状态设计）：待 Gate 2 实现评审时由实现 owner 具名同意（本记录占位，Gate 2 开始时更新）。
   - 私有部署 owner（对 attestation/egress/termination 契约）：待私有部署层选定后由部署 owner 具名同意（本记录占位）。
   - D0-L 完成状态与证据引用已补入 README Status（Gates 1-4 complete，证据见 D0-L 05-validation-and-drift.md）。
3. **编辑性修正（已执行）**：pre-claim 状态（created/session_bound/admitted/dispatching）收到 receipt 的 typed outcome 已补为 `remote_parked: receipt_unverified`（03 + RTH-10 负例）；receipt 措辞统一为绑定 `remoteTurnId`（02 step 10、04 RTH-10、05 schema 一致）；01 persona 表补 QM user 的 abort 能力。

## 残余风险

- RemoteTurnStore 专用 Postgres 语义（原子 admission、claim CAS、同库双池跨实例）的等价性测试落在 Gate 2/4 交付，尚未执行。
- 两个 owner 同意为占位记录，须在 Gate 2 实现评审与私有部署层选定后具名闭环。
- 路线图 README 与 D0-L README 的状态行（D0-L 仍写 Draft/in-progress）为程序记录自身的过期，与本规格无关，建议由程序 owner 同步刷新。

## 相关评审

- 多专家白板走查（4 路独立 + 2 路裁决）与修订：commit `147f2b1`
- 修订后独立复审（2 blocker/3 major 修复）：同一 commit 内
- Gate 1 批准评审：2026-08-15，fresh-context reviewer，有条件批准 → 条件闭环

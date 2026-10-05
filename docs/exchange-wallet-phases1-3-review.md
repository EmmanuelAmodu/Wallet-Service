# Phases 1–3 implementation review

Reviewed: 5 October 2026.

Follow-up implementation: 5 October 2026. R1, R2, R6, and R7 now have fixes and added regression coverage; whole-repository verification passes with the new regression coverage. The original reproductions below are retained as historical evidence, with pre-fix line references.

Scope: the current working tree, including single-owner identity, User registration, and the separate Sweep application. This is an implementation and test-coverage review; application records and deployment configuration were not reset or changed.

## Conclusion

Phases 1–3 are not complete end to end. Phase 1 still lacks the authoritative custody model, allocation boundaries, and bootstrap/issuance workflow. The original review reproduced reversal ordering, pending re-inclusion, subscription recovery fairness, and settlement-incident fan-out defects. Follow-up changes address all four; the external provider implementation/acceptance and Phase 1 rollout gates remain open.

| Phase | Review status                                       | Remaining gate                                                                                                                                              |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Partially implemented; no P1 task is fully complete | Custody schema/constraints, customer allocator starting at 10, hot/management bootstrap, bound derivation, issuance integration, reset/bootstrap acceptance |
| 2     | R1/R7 fixed and verified                            | Custody/execution rollout prerequisites remain separate                                                                                                     |
| 3     | R2/R6 fixes implemented; rollout still incomplete   | External P3-02 gateway/acceptance and Phase 1 prerequisites                                                                                                 |

Passing tests establish the covered behavior. The original 216-test review result did not cover the reproduced defects; added regression coverage and its follow-up verification are recorded below.

## Original findings and follow-up

### R1 — High: a reversal delivered before its settlement is permanently rejected

Tasks: **P2-08, P2-10**.

`SettlementsService.revert()` requires an already-persisted settlement batch. If an execution intent exists but `settlement.reverted.v1` revision 2 arrives before `settlement.requested.v1` revision 1, it throws `ActionRejectedError`. Ledger's processor converts this to `UnrecoverableError`. The failed transaction retains neither a reversal revision nor an inbox receipt. The late revision-1 settlement then consumes the withdrawal reservation and journals the transaction that has already been reported orphaned.

Evidence: [settlement handler](../apps/ledger/src/settlements/settlements.service.ts), lines 480–492; [processor](../apps/ledger/src/ledger.processor.ts), lines 45–47. The existing [settlement tests](../tests/exchange-settlements.test.ts), beginning at line 323, exercise settlement before reversal.

Reproduced against isolated PostgreSQL with the compiled services: reversal revision 2 failed; the later revision-1 settlement left the operation `confirmed`, the reservation `settled`, customer reserved balance `0`, and hot custody `697` after a principal of `200` and a fee of `3` against initial hot custody `900`.

- [x] Retain authenticated reversal intent durably when the referenced settlement has not arrived. Either fence stale settlement accounting or retain and compensate the referenced settlement atomically before publishing a final result.
- [x] Cover reversal before settlement, reversal before execution intent, duplicate/reordered delivery, later valid re-inclusion, and crashes around compensation. Keep holds/resources conservative until the outcome is resolved.

**Follow-up implemented:** Ledger migration `20261005150000_settlement_reversal_fence` adds `settlement_reversals` without an execution-intent foreign key. Reversal evidence and its inbox receipt commit even before intent delivery. The later matching intent inherits the revision fence; reservation releases respect the fence before that intent exists. Late orphaned settlements bind immutable transaction/content evidence without consuming the hold or posting custody movement. A newer matching canonical re-inclusion may settle once. A reversal with no posted settlement publishes a critical review incident, with no fictitious compensation batch or `settlement.reversed.v1` result. Posted settlements still compensate and restore holds transactionally. The targeted settlement/migration suite passed 14 tests, including ordering, restart, conflicting identity/revision, later re-inclusion, and crash rollback cases.

### R2 — High: pending re-inclusion can preserve credit from an orphaned finalized block

Tasks: **P3-06, P3-09**.

When a previously credited transaction is returned in a different block below finality, `check()` skips validation of the prior block because the new observation has a `blockHash`. `applyTransfer()` keeps the existing finalized transfer on a finalized-to-pending transition. The discovery row then replaces the old block hash/height with the new pending inclusion. The old credit remains available, and the prior inclusion evidence is lost even when checking the old block would prove it orphaned.

Evidence: [exchange observation service](../apps/activity-listener/src/exchange/exchange.service.ts), lines 164–176, 406–414, and 498–502. The [existing uncertainty/reorg test](../tests/exchange-discovery.test.ts), lines 312–337, covers unavailable history, same-block pending observations, and a missing inclusion with a known block mismatch; it does not cover a different pending block.

A reproduction using the compiled handler observed zero calls to prior-block validation, a transfer still `finalized`, no reversal event, and discovery state `pending` with the replacement block. This is distinct from an RPC outage: uncertainty should retain prior credit, while a positively disproven prior inclusion must compensate it.

- [x] Preserve credited inclusion evidence independently of the latest pending observation, and check the old inclusion when the block changes.
- [x] Compensate a proven orphan before processing the new pending inclusion; credit the replacement only at its required finality.
- [x] Test finalized A → pending B with A noncanonical, unavailable prior-block evidence, B disappearing, B later finalizing, and repeated recovery.

**Follow-up implemented:** ActivityListener migration `20261005180000_retained_finalized_inclusion` adds a separately retained finalized block hash/height pair and backfills consistent financially accepted transfer evidence, including failed finalized transactions that can carry custody fee losses. A replacement pending inclusion no longer overwrites that evidence. A positively disproven accepted inclusion is reversed before the replacement is processed; unknown canonical evidence retains the prior credit and its inclusion for later checks. Added discovery tests cover pending B after finalized A, unavailable prior evidence/RPC outages, B disappearing, A restoration, B later finalizing, and repeated recovery. Whole-repository follow-up verification passes with these regressions.

### R3 — High rollout blocker: customer allocation still consumes reserved accounts 0–9

Tasks: **P1-02, P1-03, P1-08**.

The existing baseline sets `wallets_account_seq` to `RESTART WITH 0`. `WalletsService.createWallet()` consumes that sequence without a customer minimum or role constraint. On fresh databases, the first ten legacy customer creations use accounts 0–9. For the same seed/chain, the uniqueness constraint then prevents creating the intended hot/management wallets at those accounts.

Evidence: [baseline migration](../apps/wallet/prisma/migrations/20261003215228_fresh_baseline/migration.sql), lines 95–99; [allocator](../apps/wallet/src/wallets/wallets.service.ts), lines 21–55; [Wallet schema](../apps/wallet/prisma/schema.prisma), lines 29–49. A compiled-service fixture returned account 0 and `m/44'/60'/0'/0/0` for a new customer wallet.

- [ ] Add an additive migration and role-aware allocator with customer minimum 10, explicit reserved-account insertion, database role/account constraints, and clear exhaustion behavior. Preserve historical migration files.
- [ ] Test first customer allocation, concurrent bootstrap/allocation, reserved-account rejection, and exhaustion.

### R4 — High rollout blocker: no production custody bootstrap or customer issuance path

Tasks: **P1-01, P1-02, P1-04, P1-06, P1-07, P1-08**.

The authoritative Wallet model has no custody domain/customer/role/management-purpose fields. `ExchangeWalletRegistry` is a projection, without seed/path ownership or one-active-hot uniqueness. There is no `custody/` bootstrap module, and `publishRegistry()` has no production callers. Customer address assignment records intent and searches for an existing registry; it does not create or derive that wallet. A real registered User therefore cannot complete address issuance through the current application flow. Successful customer tests insert the required registry rows explicitly.

Evidence: [Wallet schema](../apps/wallet/prisma/schema.prisma), lines 29–49 and 102–130; [registry publisher](../apps/wallet/src/exchange-messaging/exchange-messaging.service.ts), line 47; [assignment](../apps/wallet/src/customers/customers.service.ts), lines 150–169 and 195–241; [customer fixtures](../tests/exchange-customers.test.ts).

- [ ] Implement authoritative custody/domain/role/purpose/configuration models and enforce unique active hot0 ownership in the database.
- [ ] Wire idempotent hot0/management bootstrap and customer allocation/derivation to transactional registry fan-out and acknowledgment recovery.
- [ ] Complete the coordinated development reset/bootstrap and failure/resume rehearsal after the schema is ready; verify empty liabilities and first customer account 10.

The customer API currently blocks address publication correctly when those prerequisites are missing. This is known incomplete Phase 1 integration, rather than a regression in the Phase 3 address API.

### R5 — Medium: derivation result binding and legacy address readiness remain incomplete

Tasks: **P1-05, P1-06, P1-08**.

`wallet.derived` contains only wallet ID, path, and a nonempty address. Wallet checks the path and marks the wallet ready; it does not validate the returned address or bind the result to domain, network, seed, and request identity. A compiled-service fixture accepted `NOT_AN_ETHEREUM_ADDRESS` with the expected path. The legacy wallet read endpoint exposes derived addresses independently of the exchange readiness gate.

Evidence: [message contract](../packages/queue/src/messages.ts), lines 46–51; [Wallet result handler](../apps/wallet/src/messaging/wallet-workflow.service.ts), lines 75–84; [legacy controller](../apps/wallet/src/wallets/wallets.controller.ts), line 54.

Bitcoin regtest signing/derivation also remains absent: [chain configuration](../packages/chain/src/config.ts), lines 39–40, rejects non-mainnet Bitcoin overrides. The separate Phase 3 regtest observer does not supply this Phase 1 capability.

- [ ] Bind derivation commands/results to immutable configured identity and validate returned path/address for the enabled chain/network.
- [ ] Add Bitcoin regtest derivation/signing support before enabling that adapter.
- [ ] Gate or retire legacy address exposure for exchange-owned wallets; test malformed/wrong-network/stale results and readiness bypasses.

### R6 — Medium: disabled-network watches can permanently starve subscription recovery

Tasks: **P3-01, P3-09**.

`recoverPending()` always selects the oldest nonready customer registrations. `recover()` returns an uncertified network's row without advancing a retry time, cursor, or timestamp. Once older disabled-network rows fill the batch, a newer certified watch that needs retry is never selected. This can leave an enabled customer address unavailable permanently after its initial registration attempt fails.

Evidence: [registry service](../apps/activity-listener/src/registry/registry.service.ts), lines 157–180 and 524–539. A compiled-service reproduction with batch size 1, an older uncertified Bitcoin row, and a newer certified Ethereum row selected only Bitcoin on four recovery passes; Ethereum was never visited. The production observation scan passes a batch size of 50. Existing provider-registry tests do not cover mixed-network recovery fairness.

- [x] Filter eligible networks before applying the limit, or introduce durable retry scheduling/pagination that guarantees progress for eligible rows.
- [x] Test a full disabled-network batch ahead of a recoverable enabled watch, and certificate removal/restoration.

**Follow-up implemented:** Recovery filters certified chain/network pairs before applying the batch limit, and watch cleanup applies the corresponding provider/certification eligibility filter. Disabled pending rows remain durable without consuming an enabled network's retry batch. Certificate withdrawal also demotes previously ready watches; restored certification permits recovery again. The added provider-registry regression fills the older batch with disabled networks and verifies enabled recovery/cleanup progress across certificate removal and restoration. Whole-repository follow-up verification passes with these regressions.

### R7 — Medium: settlement incidents do not reach Sweep's review gates

Tasks: **P2-02, P2-10**, integration with **P4-00**.

Settlement fee-cap breaches, custody shortfalls, and reorgs use a private incident helper that enqueues a critical incident only to Wallet. It bypasses the shared Ledger fan-out used for other custody incidents. Sweep therefore cannot pause the affected customer/domain from these incidents.

Evidence: [settlement incident publisher](../apps/ledger/src/settlements/settlements.service.ts), lines 638–665; compare [shared result publisher](../apps/ledger/src/exchange/exchange-inbox.ts), lines 58–79. PostgreSQL reproduction found only `wallet-actions` deliveries for both fee-cap and custody-shortfall incidents, with zero matching `sweep-actions` deliveries. The existing fee-cap test verifies incident persistence, not both consumer deliveries.

- [x] Publish the same persisted incident independently to Wallet and Sweep in the producer transaction, preserving event identity and replay behavior.
- [x] Verify that each incident source activates the appropriate sticky Sweep gate, including delivery before registry and duplicate delivery.

**Follow-up implemented:** Settlement incidents now use Ledger's shared result publisher. The producer transaction persists separate `wallet-actions` and `sweep-actions` rows containing the identical persisted incident event. Customer identity is taken from the recorded execution when the incoming settlement omitted it; an incident without customer identity activates the domain gate. The targeted regression passes all three incident causes through Sweep before registry delivery, then repeats delivery and adds registry/credit events: work remains `paused_review`. Sweep still emits no execution command; native execution remains Phase 4.

### R8 — Open external implementation and acceptance gate

Task: **P3-02**, with prerequisites **P1-05–P1-08**.

The monorepo contains the provider gateway client, durable watch leases, initial-history backfill, and readiness checks. It does not contain the deployed QuickNode gateway implementation or live acceptance evidence. Provider certifications default to empty, correctly preventing address readiness. Bitcoin regtest requires separate gateway acceptance.

- [ ] Implement/deploy the external gateway protocol and validate QuickNode Sepolia/Solana Devnet watches, removal, historical coverage including empty ranges, exact units/identities, canonical RPC/trace coverage, current-epoch delivery, lost acknowledgments, and reorgs.
- [ ] Certify Bitcoin regtest separately and complete real issuance-to-credit acceptance after Phase 1 bootstrap.

See [Phase 3 gateway and rollout requirements](exchange-wallet-phase3.md).

## Additional recovery limitations recorded by the original review

- Consumer retry exhaustion requires intervention. Outbox publication means Redis accepted a job, not that the consumer committed it. Failed jobs are retained, and `npm run queue -- retry QUEUE JOB_ID` is available. There is no generic automatic repair of published registry/deposit deliveries after retry exhaustion or loss of Redis jobs. Reservation reconciliation covers held/frozen reservations only. Define and test this recovery boundary before rollout; do not describe it as having no recovery path.
- Unknown business schemas are rejected as unrecoverable queue messages and retained as Redis failures; there is no dedicated application-owned quarantine/audit surface. The plan requires durable quarantine. Confirm the intended durability/retention and recovery procedure, or implement that surface as operational-control work.
- At review time, the legacy transaction API permitted caller-selected sources without exchange holds/hot-only policy. Follow-up authentication work moves these routes to internal service authentication; this does not supply hot-only withdrawal orchestration. Retirement/policy enforcement remains P5-03, a later rollout gate rather than a missing Phase 1–3 withdrawal implementation.
- At review time, native sweeps, hot withdrawals, login/session features, and token lifecycle enablement remained later tasks. The follow-up also adds User login/token authentication separately from these financial fixes; native execution and asset lifecycle rollout gates remain open.

## Phase 1 task audit

| Task  | State   | Missing work                                                                                             |
| ----- | ------- | -------------------------------------------------------------------------------------------------------- |
| P1-01 | Partial | User/customer identity exists; authoritative custody/role/purpose/asset models absent                    |
| P1-02 | Missing | Role/index constraints and unique active hot ownership                                                   |
| P1-03 | Partial | Existing concurrency/noncycling sequence; customer boundary 10 and exhaustion handling absent            |
| P1-04 | Partial | Customer module exists; custody bootstrap and issuance-to-registry flow absent                           |
| P1-05 | Partial | Signer seed/account checks exist; complete binding, Wallet result validation, and regtest signing absent |
| P1-06 | Partial | Customer readiness checks exist; issuance integration and legacy-route gating absent                     |
| P1-07 | Pending | Actual coordinated reset/bootstrap and empty-liability verification                                      |
| P1-08 | Partial | Some derivation/concurrency fixtures; full bootstrap/boundary/exhaustion/reset acceptance absent         |

## Recommended order

1. R1/R2/R6/R7 fixes and whole-repository revalidation are complete: 231 tests pass with zero failures/skips; the phase checklist is updated.
2. Complete P1-01–P1-06, preserving existing journal and migration history; R3/R4/R5 remain pending.
3. Implement and certify the external provider gateway (P3-02/R8), then run the coordinated development reset/bootstrap and issuance-to-credit acceptance.
4. Close the reviewed P2/P3 rollout gates after those prerequisites pass; proceed to Phase 4 execution afterward.

## Original review verification

- Fresh build, ESLint, and formatting checks passed.
- Full suite against six newly created isolated service PostgreSQL databases and Redis: **216 passed, zero failures, zero skips**.
- PostgreSQL reproductions independently confirmed R1 and R7; compiled-service fixtures confirmed reserved account 0, malformed derivation acceptance, changed-block pending behavior, and mixed-network recovery starvation.
- No live QuickNode acceptance, application database reset, deployment migration, or source-code fix was performed in this review. Only review/checklist documentation was updated. Temporary reproduction outboxes were removed only from their own isolated fixture domains; append-only journals were retained.

## Follow-up verification

- Compiled settlement/migration suite: **14 passed, zero failures, zero skips**, covering R1/R7 and the existing settlement behavior. Narrow Ledger/test TypeScript and ESLint checks passed.
- Final whole-repository build, ESLint, formatting, Compose configuration, and diff checks passed. **231 tests passed, zero failures, zero skips**, including R1/R2/R6/R7 regressions and User login/public Wallet JWT ownership. The original 216-test count above remains historical.
- Ledger reversal-fence and ActivityListener retained-finalized-inclusion migrations are additive. Tests use isolated service databases; no application database reset or live provider certification was performed.

The follow-up also separates authentication from custody: User issues access tokens, public Wallet `/v1/me` derives identity from the token, and administrative compatibility routes moved under service-authenticated `/internal`. Only User/Wallet publish application HTTP ports in the development overlay; actions remain queue-driven with Ledger HTTP reads private. This does not resolve the custody-role/purpose authorization and bootstrap gaps recorded under R3/R4/R5.

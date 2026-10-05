# Phase 2 — Durable messaging and exchange accounting

Implementation date: 4 October 2026.

Follow-up, 5 October: the reviewed reversal-ordering defect (R1) and settlement-incident delivery gap (R7) are implemented with regression coverage. The targeted compiled settlement/migration suite passed 14 tests with no failures or skips; whole-repository verification passes with the new regression coverage. Phase 1 custody bootstrap and external provider acceptance remain open rollout gates. See the [Phases 1–3 review](exchange-wallet-phases1-3-review.md) and [checklist](exchange-wallet-todo.md).

Phase 2 adds the exchange accounting layer independently of the existing wallet-balance APIs. The exchange models have customer and custody-domain identity, without tenant fields. Phase 1 custody allocation/bootstrap and Phase 3 provider watch/backfill verification remain prerequisites for exposing customer addresses. Native sweep execution, signing authorization, RPC settlement evidence, and withdrawal orchestration remain the later execution phases.

## Implementation

| Tasks       | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01       | Strict versioned exchange events in `packages/queue/src/exchange-contracts.ts`; business epoch must equal the authenticated transport epoch.                                                                                                                                                                                                                                                                                                                                     |
| P2-02       | Transactional per-consumer fan-out, Wallet registry/operation projections, matching registry acknowledgments, independent execution/settlement revision counters, and ActivityListener-owned PostgreSQL inbox/registry/outbox. Settlement fee-cap, custody-shortfall, and reorg incidents use the shared publisher: independent Wallet/Sweep outbox rows contain the same persisted event identity and payload.                                                                  |
| P2-03–P2-05 | Metadata-only account identities, independent journal batches and entries, deposit/reservation/operation references, and separate custody and customer liability accounts.                                                                                                                                                                                                                                                                                                       |
| P2-06       | Pending observations remain nonspendable; finality credits once. Reorgs compensate journal entries, freeze shortfalls, and record explicit deficits. Restored deposits offset deficits before creating frozen liabilities.                                                                                                                                                                                                                                                       |
| P2-07       | Atomic principal/accepted-fee holds, immutable request identity, quote-expiry/frozen-customer rejection, safe idempotent release, and committed result outboxes.                                                                                                                                                                                                                                                                                                                 |
| P2-08       | Confirmed sweep/funding moves custody without changing customer balances. Hot withdrawals settle principal, accepted fee revenue, and actual native network expense. Failed on-chain attempts release unpaid obligations while recording paid fees. Versioned outgoing reversals restore the same obligation and record shortfalls. Durable reversal fences also survive arrival before settlement or execution intent, retain the hold, and reject stale settlement accounting. |
| P2-09       | Authenticated customer balance/reservation reads and explicit reservation reconciliation. Missing operations or inconsistent terminal results create incidents; they never authorize automatic release.                                                                                                                                                                                                                                                                          |
| P2-10       | PostgreSQL and Redis tests exercise concurrent holds, replay/reordering, immutable per-asset journals, custody-only movement, reorgs, deficit recovery, and committed-hold delivery after a lost Redis acknowledgment. Added regression cases cover reversal before settlement/intent, restart, conflicting replay, newer canonical re-inclusion, compensation crash rollback, and all three settlement-incident causes pausing Sweep before registry delivery.                  |

Ledger journals are append-only. PostgreSQL verifies account ownership/type, bounded integer base units, predecessor/sequence/balance consistency, and deferred balance per asset/network. Batches cannot accept entries from a later transaction. Foreign keys retain customer, wallet, reservation, and journal references. Account metadata contains no mutable balance or sequence cursor; account tails remain the balance source.

Financial handlers initially serialize by custody domain through a PostgreSQL transaction lock, then lock account tails in a consistent order. This favors correctness for the initial exchange; throughput expansion remains Phase 9. In-transit custody has its own account and is excluded from hot custody balances.

Once Ledger records an execution intent, its reservation stays held even if signing/submission status has not arrived. A definitive on-chain failure can settle paid fees and release unpaid amounts. Explicit proof and cancellation acknowledgment for an unspent execution intent belong to the execution workflow; a timeout, missing operation, or failed queue job cannot release its hold.

`settlement_reversals` retains authenticated reversal evidence independently of `exchange_operations`, so missing execution intent cannot discard a reversal after queue retry exhaustion. Operation ID/reversal revision identifies the immutable domain, epoch, attempt, request, and prior settlement revision. A later matching intent inherits the highest reversal revision and `reverted` state. A reservation-release request also respects this fence when the intent has not arrived. Late orphaned settlement evidence binds the transaction/content identity without posting the payment; only a newer matching canonical inclusion may settle the obligation.

When no settlement journal exists, the reversal commits its durable fence, inbox receipt, and critical incident. It creates no compensating journal and emits no `settlement.reversed.v1` result containing a fictitious batch. When a posted settlement exists, compensation, hold restoration, incident fan-out, and the reversed result commit together. Critical incidents pause the customer in Sweep, or the custody domain when no customer is supplied; the pause survives later registry and duplicate delivery.

## Internal API and operator compatibility

All routes are private service interfaces and require `Authorization: Bearer <LEDGER_API_KEY>`. Queue commands/events are the preferred action transport; these HTTP routes provide authenticated internal reads and administrative/compatibility operations.

Normal inter-service actions and financial writes enter through the HMAC-authenticated Ledger queue. Wallet uses HTTP only for reads. Legacy `POST /internal/wallets` registration is removed; `ledger.wallet.registered` is delivered by the Wallet outbox. The two private operator compatibility actions below retain service-key authentication and are not public ingress or normal application-to-application transport.

- Operator compatibility only: `POST /internal/exchange/events` validates and applies a versioned exchange command/event, committing inbox, transition, journal, and result outbox together. Financial identity/state conflicts return HTTP 409. Missing execution intent still makes ordinary settlement/attempt observations retryable; reversal evidence commits its independent durable fence even without that intent.
- `GET /internal/exchange/customers/:customerId/balances?domainId=...`: customer pending, available, reserved, and frozen balances as integer strings. Custody balances are separate.
- `GET /internal/exchange/reservations?domainId=...&cursor=...`: page durable reservation state.
- `GET /internal/exchange/reservations/:reservationId?domainId=...`: read one reservation in its domain.
- Operator compatibility only: `POST /internal/exchange/reservations/reconcile`: `{ "domainId": "...", "limit": 100 }`; redeliver committed results and ask Wallet for operation evidence. Inspect Ledger incidents for orphan or inconsistent obligations.

Queue processors call the same handlers. Each business event retains its ID/content on retry, and each consumer commits a durable inbox receipt. Result events are persisted before publication, with independent deliveries for each consumer.

The ActivityListener registry acknowledges durable receipt with `rejected`/`awaiting_phase3_provider_watch_and_backfill_coverage`. It cannot claim readiness from persistence alone. Wallet accepts a listener-ready acknowledgment only with matching registry revision, explicit complete coverage, and a backfill cursor.

## Database setup

ActivityListener now owns `ACTIVITY_DATABASE_URL`, defaulting locally to `postgresql://activity:activity_local_only@127.0.0.1:5435/activity`. Each application receives only its own database credentials.

```sh
docker compose up -d postgres broadcast-postgres ledger-postgres activity-postgres sweep-postgres user-postgres redis pubsub
npm run db:generate
npm run migrate
npm run build
```

Wallet and Ledger changes are additive migrations over the existing baselines. ActivityListener, Sweep, and User own separate databases. Independent deployment uses `migrate:wallet`, `migrate:broadcast`, `migrate:ledger`, `migrate:activity`, `migrate:sweep`, and `migrate:user`. Ledger migration `20261005150000_settlement_reversal_fence` adds durable pre-intent reversal evidence without changing historical migrations or journals. ActivityListener migration `20261005180000_retained_finalized_inclusion` separately retains accepted inclusion evidence for Phase 3 reorg checks. Development reset tooling covers all six application databases; implementation verification does not reset application data or rotate the development epoch.

## Verification

Configure dedicated `TEST_DATABASE_URL`, `TEST_BROADCAST_DATABASE_URL`, `TEST_LEDGER_DATABASE_URL`, `TEST_ACTIVITY_DATABASE_URL`, `TEST_SWEEP_DATABASE_URL`, `TEST_USER_DATABASE_URL`, and `TEST_REDIS_URL`, then run `npm test`, `npm run lint`, and `npm run format:check`. Tests use deterministic chain fixtures and no live funds. The reservation outbox interruption test creates/drops its own temporary database; the dedicated Ledger test role needs `CREATEDB` permission. CI provides these dependencies.

The initial Phase 2 verification passed **122 tests** with zero failures or skips. The pre-fix 5 October review passed **216 tests**, but that result did not cover R1/R7. The new targeted settlement/migration run passed **14 tests**, including the four added regression cases, with zero failures or skips; narrow TypeScript and ESLint checks also passed. The final whole-repository build and 231-test run passed with zero failures/skips, including User login, Wallet JWT ownership, R2 retained inclusion, and R6 recovery fairness; ESLint, formatting, Compose configuration, and diff checks passed. Actual deployment migrations, Phase 1 bootstrap/reset, provider certification, and live-chain acceptance remain separate gates.

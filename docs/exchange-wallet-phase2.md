# Phase 2 — Durable messaging and exchange accounting

Implementation date: 4 October 2026.

Phase 2 adds the exchange accounting layer independently of the existing wallet-balance APIs. The exchange models have customer and custody-domain identity, without tenant fields. Phase 1 custody allocation/bootstrap and Phase 3 provider watch/backfill verification remain prerequisites for exposing customer addresses. Native sweep execution, signing authorization, RPC settlement evidence, and withdrawal orchestration remain the later execution phases.

## Implementation

| Tasks | Implementation |
| --- | --- |
| P2-01 | Strict versioned exchange events in `packages/queue/src/exchange-contracts.ts`; business epoch must equal the authenticated transport epoch. |
| P2-02 | Transactional per-consumer fan-out, Wallet registry/operation projections, matching registry acknowledgments, independent execution/settlement revision counters, and ActivityListener-owned PostgreSQL inbox/registry/outbox. |
| P2-03–P2-05 | Metadata-only account identities, independent journal batches and entries, deposit/reservation/operation references, and separate custody and customer liability accounts. |
| P2-06 | Pending observations remain nonspendable; finality credits once. Reorgs compensate journal entries, freeze shortfalls, and record explicit deficits. Restored deposits offset deficits before creating frozen liabilities. |
| P2-07 | Atomic principal/accepted-fee holds, immutable request identity, quote-expiry/frozen-customer rejection, safe idempotent release, and committed result outboxes. |
| P2-08 | Confirmed sweep/funding moves custody without changing customer balances. Hot withdrawals settle principal, accepted fee revenue, and actual native network expense. Failed on-chain attempts release unpaid obligations while recording paid fees. Versioned outgoing reversals restore the same obligation and record shortfalls. |
| P2-09 | Authenticated customer balance/reservation reads and explicit reservation reconciliation. Missing operations or inconsistent terminal results create incidents; they never authorize automatic release. |
| P2-10 | PostgreSQL and Redis tests exercise concurrent holds, replay/reordering, immutable per-asset journals, custody-only movement, reorgs, deficit recovery, and committed-hold delivery after a lost Redis acknowledgment. |

Ledger journals are append-only. PostgreSQL verifies account ownership/type, bounded integer base units, predecessor/sequence/balance consistency, and deferred balance per asset/network. Batches cannot accept entries from a later transaction. Foreign keys retain customer, wallet, reservation, and journal references. Account metadata contains no mutable balance or sequence cursor; account tails remain the balance source.

Financial handlers initially serialize by custody domain through a PostgreSQL transaction lock, then lock account tails in a consistent order. This favors correctness for the initial exchange; throughput expansion remains Phase 9. In-transit custody has its own account and is excluded from hot custody balances.

Once Ledger records an execution intent, its reservation stays held even if signing/submission status has not arrived. A definitive on-chain failure can settle paid fees and release unpaid amounts. Explicit proof and cancellation acknowledgment for an unspent execution intent belong to the execution workflow; a timeout, missing operation, or failed queue job cannot release its hold.

## Internal API

All routes require `Authorization: Bearer <LEDGER_API_KEY>`. This is an exchange-backend API, not direct customer authentication.

- `POST /internal/exchange/events`: validate and apply a versioned exchange command/event, committing inbox, transition, journal, and result outbox together. Financial identity/state conflicts return HTTP 409. Retryable missing execution intent leaves no inbox acknowledgment.
- `GET /internal/exchange/customers/:customerId/balances?domainId=...`: customer pending, available, reserved, and frozen balances as integer strings. Custody balances are separate.
- `GET /internal/exchange/reservations?domainId=...&cursor=...`: page durable reservation state.
- `GET /internal/exchange/reservations/:reservationId?domainId=...`: read one reservation in its domain.
- `POST /internal/exchange/reservations/reconcile`: `{ "domainId": "...", "limit": 100 }`; redeliver committed results and ask Wallet for operation evidence. Inspect Ledger incidents for orphan or inconsistent obligations.

Queue processors call the same handlers. Each business event retains its ID/content on retry, and each consumer commits a durable inbox receipt. Result events are persisted before publication, with independent deliveries for each consumer.

The ActivityListener registry acknowledges durable receipt with `rejected`/`awaiting_phase3_provider_watch_and_backfill_coverage`. It cannot claim readiness from persistence alone. Wallet accepts a listener-ready acknowledgment only with matching registry revision, explicit complete coverage, and a backfill cursor.

## Database setup

ActivityListener now owns `ACTIVITY_DATABASE_URL`, defaulting locally to `postgresql://activity:activity_local_only@127.0.0.1:5435/activity`. Each application receives only its own database credentials.

```sh
docker compose up -d postgres broadcast-postgres ledger-postgres activity-postgres redis pubsub
npm run db:generate
npm run migrate
npm run build
```

Wallet and Ledger changes are additive migrations over the existing baselines. ActivityListener receives its own baseline. Independent deployment uses `migrate:wallet`, `migrate:broadcast`, `migrate:ledger`, and `migrate:activity`. Development reset tooling includes all four databases; implementation verification does not reset application data or rotate the development epoch.

## Verification

Configure dedicated `TEST_DATABASE_URL`, `TEST_BROADCAST_DATABASE_URL`, `TEST_LEDGER_DATABASE_URL`, `TEST_ACTIVITY_DATABASE_URL`, and `TEST_REDIS_URL`, then run `npm test`, `npm run lint`, and `npm run format:check`. Tests use deterministic chain fixtures and no live funds. The reservation outbox interruption test creates/drops its own temporary database; the dedicated Ledger test role needs `CREATEDB` permission. CI provides these dependencies.

The full suite passed all **122 tests**, with **zero failures and zero skips**, against isolated PostgreSQL databases and Redis namespaces. Application/tooling build, ESLint, formatting, and diff checks also passed. Actual deployment migrations, Phase 1 bootstrap/reset, provider certification, and live-chain acceptance remain separate gates.

# Phase 7 — Operational recovery and controls

Updated: 13 October 2026. This phase adds reconciliation and audited recovery to the existing applications. It adds no public worker endpoints and does not enable spending.

## Ownership and reconciliation

Wallet owns monitoring runs, operator commands, funding gates, alert reviews and metric projections. Ledger owns immutable reconciliation evidence and financial comparisons. They communicate through authenticated outboxes and queues; neither application reads the other's database.

Monitoring rotates through published hot, management and customer addresses, including inactive published addresses in the current custody epoch. Provider subscriptions remain limited to customer deposit addresses. Ethereum reads finalized balances/nonces at one block, rechecks its identity and validates certified token code. Bitcoin verifies a canonical regtest UTXO scan, records exact satoshis and the output-set digest. Solana reads System balances and classic owned-token-account balances/rent with matching account contexts; mixed slots, pruned history and invalid ownership remain unavailable. It never substitutes zero for a failed read.

Ledger compares each sampled wallet's physical custody with its liquid custody and recoverable rent accounts. Per-asset totals explain customer available/reserved/frozen/pending liabilities, exchange equity, fees, deficits, reconciliation and in-transit balances. Journal debit/credit equations and a journal-batch watermark are retained with each report. In-flight operations are explanations to investigate, not permission to hide a difference or adjust a journal. Sampling and comparison do not post, delete or amend financial entries.

Hot/management nonce advances without corresponding canonical application executions produce retained critical alerts. New Bitcoin/Solana root activity outside recorded execution produces review alerts; Solana signature-window overflow requires archival backfill. Balance changes can expose external funding, unposted deposits, unauthorized withdrawals, gifted ATA rent and delayed fee/settlement projections. An alert does not automatically classify an unexplained balance as a customer deposit or exchange capital.

## Configuration and private API

`ENABLE_OPERATIONS_MONITORING=false` is the deployment default. Enable it after applying Wallet and Ledger migrations. `OPERATIONS_MONITOR_INTERVAL_MS` defaults to 30 seconds, `OPERATIONS_SAMPLE_FRESHNESS_MS` to five minutes and `OPERATIONS_MONITOR_BATCH_SIZE` to 25 wallets. Tune cadence, batch size and RPC capacity together; a large deployment needs enough sampling capacity to cover all published wallets within the freshness window. Bitcoin scan contention and unavailable/pruned RPC history are retained as unavailable evidence.

Wallet exposes these **internal** routes:

- `GET /internal/operations`: recent runs, alerts and audited commands, scoped to the configured domain/epoch.
- `GET /internal/operations/metrics`: metric reports with timestamps, integer values and labels. An external monitoring collector can consume this authenticated JSON endpoint; no external notification destination is configured by this change.
- `POST /internal/operations/commands`: strict command body with a UUID `commandId`, nonempty `reason` and an action-specific target.

All routes require both `Authorization: Bearer <WALLET_API_KEY>` and `X-Operations-Key: <OPERATIONS_API_KEY>`. The operations key must differ from Wallet, exchange, Ledger and queue credentials. `OPERATIONS_ACTOR` identifies the credential holder in audit records; callers cannot override it in the body. Customer login tokens cannot access these routes. Without an operations credential, the private API remains unavailable.

Commands:

| Action | Target and behavior |
| --- | --- |
| `reconcile` | Request fresh samples through Wallet's own queue, without waiting on chain RPC inside the HTTP request. |
| `repair` | Repair due executions/withdrawals, retry existing authenticated failed Wallet jobs and request Ledger/Sweep/Listener/Broadcast recovery through queues. |
| `retry-execution` | `transactionId`; reconcile first, then repeat the original retained signed dispatch only when its original resource claims still belong to that execution. Never derives a new authorization, changes bytes or creates a replacement. |
| `cancel-withdrawal` | `withdrawalId`; use the existing cancellation saga. Signed, authorized or uncertain payment is not made cancellable by an operator command. |
| `pause-domain` | Quarantine future spending and fan out durable review evidence to Ledger/Sweep. |
| `resume-domain` | Require fresh complete wallet coverage, reviewed critical alerts, no custody shortages/deficits or unavailable evidence, and independent Ledger approval at the recorded journal watermark. Reviewed custody surpluses remain visible. A newer quarantine or unresolved canonical reorg defeats an earlier approval. |
| `freeze-customer` | `customerId`; freeze Wallet immediately and queue Ledger/Sweep incident processing. Financial liabilities and reservations remain intact. |
| `pause-funding` / `resume-funding` | Serialize management gas funding and SPL sponsorship gates with reservation/authorization. Resuming does not change token/native feature flags or release old exposure. |
| `review-incident` | `alertId`; record actor/reason/command evidence. A review does not erase the alert, rewrite journals or thaw a customer. |

Command identity, actor, reason, domain and epoch are immutable. Duplicate command IDs with different requests are rejected. Accepted commands interrupted by a crash are retried by the monitoring worker. Queue completion acknowledges an operational action, not a payment or a released customer hold. A rejected domain-activation proof needs a new command ID and fresh evidence.

## Repairs and metrics

Wallet repairs due custody executions and withdrawals, republishes stranded execution/registry evidence and retries bounded failed jobs with their original authenticated payloads. Invalid authentication, stale epochs and foreign domains are skipped. The background transport repair does not block database recovery when Redis is unavailable.

Ledger replays retained credited-deposit, registry, reservation and settlement results, reconciles held/frozen reservations, and re-emits existing custody reports on replay. A missing Wallet operation is an incident requiring payment/nonpayment evidence, never a timeout-based hold release. Sweep scans eligible/residual work under existing source fences. Listener repairs subscriptions, owned-account watches, backfill and due canonical discoveries. Broadcast performs canonical confirmation checks of existing attempts; its periodic repair does not create new dispatch bytes.

Metrics and persisted alerts cover wallet custody differences, liquid hot/management balances, customer custody awaiting sweep, original hot execution principal/fee claims, withdrawal backlog/age, unswept work/age, dust, gas dependencies, registry lag, deposit verification age, unresolved Ledger incidents, held reservations, broadcast uncertainty, reorg exposure, consumer report age and stalled outbox delivery. Values remain integer base units or milliseconds; they are not fiat values. A stale report is not current evidence that the system is healthy.

## Recovery runbooks

### Provider gaps or missing deposit credit

Inspect registry/backfill cursors, token-specific coverage and Listener heartbeat. Restore the gateway/RPC history and issue `repair`. Replay retained transfer identities; verify one deposit credit and no credit for management funding or a sweep. Do not credit from provider summaries or current wallet balance alone. Root accounts use RPC reconciliation, not provider watches.

### Redis or process outage

Preserve databases, execution keys and the custody epoch. Restore Redis/processes, inspect pending outbox age and run `repair`. Replayed messages keep their original identity and immutable financial intent. Verify restored registration, holds, sweep work and settlement acknowledgments. Do not rotate the epoch or run the development reset to clear a production backlog.

### Unknown broadcast, expiry or lost signing response

Keep the original hold and resource claims. Run `retry-execution` to reconcile and, when retained signed evidence exists, repeat those exact bytes. Confirmation recovery must use canonical history. Authorization/blockhash expiry does not authorize replacing a transaction or releasing its hold. If the signing result itself is lost and no canonical payment/nonpayment proof exists, retain uncertainty and obtain the missing evidence; this phase does not invent replacement bytes.

### Canonical reorg

Quarantine the affected custody flow, reconcile the original attempt and deliver its compensating settlement. Verify one reversal of principal, fees and rent and restoration of the original withdrawal obligation. An operator may retry retained signed bytes under their retained claims while new authorizations remain quarantined. Restore canonical settlement before requesting domain activation. No automatic fee bump or blockhash refresh is introduced.

### Low hot or management liquidity

Inspect actual liquid balances, pending fee reservations, rent and original withdrawal holds. Pause management funding if its budget/liquidity needs review. Fund approved custody accounts using the established capital/funding procedure and ensure native capital is represented in Ledger. External capital and gifted account rent remain differences until their financial attribution is verified; reconciliation does not silently book them as customer credit or equity. Resume funding and repair existing work after inspection.

### Unexpected outflow or nonce/activity advance

Pause the domain, freeze affected customers, inspect canonical transactions and signing access, and retain evidence. Reconcile missing legitimate postings or the verified loss through the financial saga. Review alerts with an audit reason. Resume the domain only after complete fresh evidence and Ledger approval; customer thawing or unexplained financial correction is not implicit in domain activation.

The development reset remains an initial disposable-environment procedure. Ongoing recovery preserves published identities, commands, operations, holds, financial journals and canonical evidence.

## Verification

Acceptance includes canonical/malformed/unavailable RPC reads, exact Bitcoin units, mixed Solana contexts, per-asset accounting equations, private-route authentication, forbidden operator actions, queue epoch isolation, immutable audit identity, funding pause/resume, nonce alerts, duplicate reports, domain activation and stale quarantine races. Existing token/native custody and financial tests remain regression gates. No application database, real provider subscription, signing key or real fund is changed by local fixture verification.

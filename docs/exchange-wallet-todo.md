# Exchange wallet implementation TODO

Date: 4 October 2026  
Status: Phase 2 implemented and verified; other phase gates remain pending

Design reference: [Exchange wallet implementation plan](exchange-wallet-implementation-plan.md)

Initial configuration and worker answers: [implementation decisions](exchange-wallet-initial-decisions.md). The target is one exchange per deployment, with no tenant model.

## How to work through this checklist

- Work through phases 0–8 in order. Phase 9 contains optional follow-up work.
- Use the task IDs when discussing, implementing, or reviewing work. Start with **P0-01**.
- Mark a task complete only when its implementation and relevant verification are complete. Record blockers or implementation links beneath the task.
- Complete each phase's gate before enabling the next customer-facing capability. Preparatory work can run in parallel when its prerequisites are ready.
- Existing development records can be discarded. Use a coordinated reset; no legacy-address or opening-balance migration is required.

| Phase | Deliverable | Prerequisite | Status |
| --- | --- | --- | --- |
| 0 | Agreed configuration and contracts | None | Pending |
| 1 | Custody roles, allocation, and clean bootstrap | 0 | Pending |
| 2 | Durable messaging and exchange accounting | 1 | Complete (implementation; deployment gated) |
| 3 | Deposit detection, credit, and customer APIs | 2 | Pending |
| 4 | Safe execution and native sweeps | 3 | Pending |
| 5 | Hot-wallet withdrawals | 4 | Pending |
| 6 | ERC-20 and SPL lifecycle support | 5 | Pending |
| 7 | Operational recovery and controls | 6 | Pending |
| 8 | End-to-end acceptance and rollout | 7 | Pending |
| 9 | Optional throughput and domain expansion | 8 | Backlog |

## Phase 0 — Configuration and contracts

- [x] **P0-01** Apply the initial single-exchange decisions: globally unique customer external IDs, one development seed, Sepolia, Bitcoin regtest, and Solana Devnet; one network per chain. Record the configured seed identifier and verify each RPC identity before enabling its adapter. Development profile and mocked identity checks are recorded; live RPC checks are pending, and Bitcoin remains disabled until P1-05.
- [x] **P0-02** Confirm the derivation convention: hardened `Wallet.account` 0 for hot, 1–9 reserved for management, and customer accounts starting at 10. Define account 1's gas/fee purpose and limits. Per-chain derivation paths and management budgets are recorded; signer fixtures verify accounts 0, 1, 9, and 10. Role enforcement and allocator boundaries remain P1 work.
- [x] **P0-03** Define canonical asset metadata and adapter capabilities, including native assets, allowlisted ERC-20/SPL assets, decimals, token identity/program, and unsupported-asset handling. The decisions record now defines `(chain, network, asset_id)`, native and token ID forms, pinned metadata, lifecycle certification gates, conservative ERC-20/SPL scope, and custody-exception behavior. Runtime registry and enforcement remain later implementation work.
- [x] **P0-04** Implement/version the financial defaults in the decision record: Ethereum finalized blocks, Bitcoin 6 confirmations, Solana finalized, positive base-unit credit, sweep economics, fee/rent/funding caps, zero development customer withdrawal fee, cancellation fences, and deficit handling. Require hot liquidity before execution. `exchange-financial-v1` is the normative development policy; accepted operations retain their policy version, and withdrawal signing/submission requires atomic hot0 liquidity reservations.
- [x] **P0-05** Define operation/attempt state machines and versioned queue contracts, including registry acknowledgments, deposit credit/reversal, reservation, execution, settlement, release, and incidents. The implementation plan separates business schema versions from the HMAC transport envelope and specifies event identities, outbox/inbox delivery guarantees, aggregate transitions, and cancellation/reorg safety. Shared runtime schemas are implemented in P2-01.
- [x] **P0-06** Confirm RPC/indexer/provider capabilities for deposit subscriptions, transfer identities, historical backfill, Bitcoin UTXO discovery, and Solana token accounts. Record required changes in the external provider. Source review confirms webhook intake but no wallet-watch lifecycle/backfill cursor or Bitcoin UTXO adapter, and identifies lost BTC/EVM/Solana transfer identity/base-unit details. Helius is deprecated for the exchange; Solana provider selection and deployed QuickNode capabilities remain pre-enable gates because credentials/config are unavailable here.
- [ ] **P0-07** Write the coordinated development reset procedure and tooling: stop workers/publisher, reset owned databases and project queue/registry state, remove old subscriptions, configure fresh state, bootstrap, and restart. Queue envelope v2 and Pub/Sub ingress enforce `RESET_EPOCH`; provider payloads require top-level `resetEpoch`; BullMQ keys are epoch-prefixed. The reset tool reads durable `.env` directly despite stale shell exports and holds an exclusive owner-token lock through destructive work and final marker clearing; completion verifies the durable epoch and marker. Services reject conflicting runtime epochs. Persist `RESET_IN_PROGRESS` before destructive work, block service startup, and resume the same epoch/old namespaces after failure; stale-lock recovery must be explicit. **Still open:** execute the coordinated reset after the Phase 1 schemas are ready and rehearse a failure/resume cycle. Provider watch removal/publisher reconfiguration and wallet bootstrap remain explicit operator steps.

**Gate:** configuration and contracts are recorded; external dependencies are known; the reset procedure can be run once the updated schemas are ready.

## Phase 1 — Custody roles, allocation, and bootstrap

- [ ] **P1-01** Add Wallet-owned Prisma models for custody domains, globally unique customer external IDs, wallet roles, management purposes, asset configuration, and subscription readiness. Remove tenant fields from the exchange model/contracts/authentication as it is implemented; keep seed material outside PostgreSQL.
- [ ] **P1-02** Add database constraints for hot account 0, management accounts 1–9, customer accounts >=10, and one active hot wallet per domain/chain/network. Preserve seed/chain/account key uniqueness and canonical addresses.
- [ ] **P1-03** Update the customer allocator and baseline sequence to start at 10, remain noncycling, enforce the account bound, and allocate safely across replicas. Explicit hot/management inserts must not advance it.
- [ ] **P1-04** Implement `custody/` and `customers/` NestJS modules with idempotent hot bootstrap, explicit management creation, and immutable published seed/account/path ownership.
- [ ] **P1-05** Bind bootstrap and address derivation requests/results to the configured domain, seed, chain, and network; verify returned addresses and paths against expected derivation. Add explicit Bitcoin regtest address/signing/RPC support before enabling that development adapter.
- [ ] **P1-06** Implement readiness state: customer addresses remain unavailable until the hot destination, Ledger registration, provider subscription, and listener registry are acknowledged.
- [ ] **P1-07** Run the coordinated development reset after the custody schema is ready. Bootstrap hot0 and configured management wallets, then verify the first customer account is 10 and customer liabilities start empty. Use a fresh development seed/local chain when empty on-chain state is required.
- [ ] **P1-08** Verify concurrent bootstrap/allocation, reserved-index rejection, customer authorization and seed/network isolation, allocator exhaustion, repeated reset/bootstrap, and rejection of jobs from a prior reset.

**Gate:** hot0 is deterministic; customer allocation cannot use 0–9; concurrent workers cannot create conflicting wallets. Address publication stays gated until phase 3 completes subscription readiness.

## Phase 2 — Durable messaging and exchange accounting

- [x] **P2-01** Implement the shared versioned contracts in `packages/queue`, with domain/customer, canonical asset/network, operation/attempt IDs, request digest, correlation/causation IDs, revision, and schema version. `packages/queue/src/exchange-contracts.ts` now provides strict `schemaVersion: 1` runtime schemas for registry, deposit/deficit, reservation/release, execution, settlement, and incident events. Producer/consumer routing and transactional fan-out are implemented in P2-02.
- [x] **P2-02** Add explicit outbox fan-out to consumer-owned queues. Deliver registry events separately to Ledger and ActivityListener; persist acknowledgments. Retain database inbox deduplication and transition guards beyond queue retention.
- [x] **P2-03** Extend Ledger's Prisma schema with metadata-only `LedgerAccount` identities/types/owners, journal batches independent of on-chain activities, deposits, withdrawal reservations, operation/journal links, inbox records, and its own transactional outbox. Keep balances in append-only entries; wire the Ledger outbox relay.
- [x] **P2-04** Implement Ledger feature boundaries for accounts, deposits, reservations, and settlements. Preserve immutable balanced journals, sequence locking, predecessor links, and compensating-entry references.
- [x] **P2-05** Separate physical custody accounts from customer pending/available/reserved/frozen liabilities. Use bounded integer base units and separate balances for each asset/network; exclude in-transit custody from spendable hot liquidity.
- [x] **P2-06** Implement final-deposit credit exactly once and pending/final/reverted transitions. Atomically publish `deposit.credited` with its journal entry; add deficit/freeze handling when reversing funds already withdrawn.
- [x] **P2-07** Implement atomic balance-check-and-reserve, idempotent release, and reservation result events. Reserve principal plus the accepted customer fee, using separate holds when fee assets differ.
- [x] **P2-08** Implement custody-only sweep/funding postings and withdrawal settlement, with actual native network fees, accepted fee revenue, failed-on-chain fees, and versioned settlement reversals. Unknown outcomes retain holds.
- [x] **P2-09** Add reservation reconciliation for missing operations/events and expose authenticated customer balance reads through Ledger. Keep all applications on their own databases.
- [x] **P2-10** Verify simultaneous holds cannot overspend; duplicate/reordered events cannot credit or settle twice; funding/sweeps leave customer liabilities unchanged; journal entries balance per asset; crashes after reservation commit recover through the outbox.

**Gate:** verified against isolated PostgreSQL databases and Redis: Ledger owns customer balances and holds durably. Financial transitions are idempotent, balanced, and recoverable without cross-application database reads.

**Verification:** 122 tests passed, with no failures or skips; application/tooling build, ESLint, formatting, and diff checks passed. See [Phase 2 implementation notes](exchange-wallet-phase2.md) for code mapping, APIs, migrations, and verification setup. Phase 1 custody bootstrap and Phase 3 provider readiness still gate customer-facing deployment. Application data was not reset and deployment databases were not migrated.

## Phase 3 — Deposit listener and customer deposit APIs

- [ ] **P3-01** Implement the listener registry projection, revision checks, readiness acknowledgments, and rebuild procedure. Pause affected processing during registry gaps/rebuilds and close gaps through replay/backfill.
- [ ] **P3-02** Implement provider subscription installation/removal, acknowledgment persistence, start block/slot, and backfill cursors. Subscribe to customer deposit addresses and relevant owned SPL token accounts. Select and certify the replacement Solana RPC/indexer provider and verify deployed watch/backfill capabilities, stable transfer identities, raw units, and current-epoch delivery for every enabled network before exposing customer addresses.
- [ ] **P3-03** Treat provider notifications as discovery signals; verify network and canonical chain data through RPC before publishing normalized financial observations.
- [ ] **P3-04** Replace transaction-level balance-change identity with transfer identity: Bitcoin `txid:vout`, ERC-20 transaction/log index, EVM native transfer/trace identity, and Solana instruction/inner-instruction plus token identity.
- [ ] **P3-05** Classify external deposits, internal funding, persisted authorized sweeps, and unexpected outflows. Use trusted registry/operation data; unrelated external counterparties must not fail the whole observation.
- [ ] **P3-06** Publish observed/finalized/reverted deposit events and maintain Wallet's deposit/history projection from Ledger results. Normalize addresses and assets consistently across services.
- [ ] **P3-07** Persist incidents for unexpected customer-wallet outflows, apply configured freezes, and reconcile custody loss without silently reducing customer liabilities. Match sweeps by attempt, source, asset, hot destination, amount, and fee bounds.
- [ ] **P3-08** Add idempotent customer deposit-address assignment, balance, and deposit-history APIs with exchange-backend authentication and customer ownership validation. Expose addresses only after all readiness acknowledgments.
- [ ] **P3-09** Verify replay, multiple outputs/logs, alias/case normalization, out-of-order finality, registry lag, resubscription/backfill, and reorgs. Internal funding and hot sweep receipts must never create a second customer credit.

**Gate:** supported external deposits credit the correct customer once; registry/subscription gaps are recoverable; only ready addresses are published.

## Phase 4 — Safe execution and native sweeps

- [ ] **P4-01** Add durable sweep, attempt, funding, and resource-reservation models and `sweeps/`/`treasury/` modules. Persist operation revisions, hot generation, deferral reasons, retry time, and immutable attempt/replacement lineage.
- [ ] **P4-02** Implement source execution reservations before preparation/signing. Retain `one_pending_per_wallet`; signed, submitted, and uncertain attempts keep their slot until reconciliation proves it can be released.
- [ ] **P4-03** Implement trusted Signer policy authorization independent of queue HMAC. Verify source derivation/role, configured purpose, asset/network, destination, fee/output bounds, authorization expiry/policy revision, and request digest; bind results to the attempt and derive keys only in memory.
- [ ] **P4-04** Extend prepare/sign/broadcast contracts and Broadcast persistence with operation/attempt references and settled fee/result information. Validate signer-result digest/revision/state, then automatically enqueue broadcast through Wallet's outbox while preserving immutable signed snapshots and same-byte retries.
- [ ] **P4-05** Build sweep scheduling from `deposit.credited`: coalesce eligible work, re-read canonical resources, reserve inputs, and defer insufficient funds/gas or uneconomical dust. Arrivals during an active attempt become later work.
- [ ] **P4-06** Implement EVM native sweep-max with gas estimation/caps, worst-case fee allowance, hot-only payout, and residual re-evaluation.
- [ ] **P4-07** Implement watch-only/indexer Bitcoin UTXO discovery, ownership/maturity/finality checks, durable outpoint reservations, and sweep-all signing with hot-only asset outputs. Split large input sets and defer uneconomical dust; do not return change to the customer source.
- [ ] **P4-08** Implement Solana native sweeps with fee/rent policy, available-balance validation, expiry handling, and retained prior-inclusion evidence across RPC outages.
- [ ] **P4-09** Connect idempotent confirmation/actual-fee settlement and failed/attention states. Correlate Listener and Broadcast observations so either arrival order journals the movement once. Reconcile unknown RPC outcomes and superseded attempts before releasing resources or initiating another spend.
- [ ] **P4-10** Implement post-confirmation canonical checks and sweep reorg compensation. Reassess resources after reversal without changing customer liabilities or double-paying through a delayed old attempt.
- [ ] **P4-11** Add periodic residual/missed-trigger repair scans. Persist operational exceptions for unsupported assets, uneconomical balances, and repeated preparation failures.
- [ ] **P4-12** Verify all native adapters with deterministic failure tests and independently decoded signed-transaction smoke runs: dust, fee increases, mid-sweep deposits, spent/immature UTXOs, crashes, lost RPC responses, expiry, stale signer results, duplicate confirmation, and confirmed-then-reorg recovery. Reject altered role, destination, network, and authorization digest.

**Gate:** Ethereum, Bitcoin, and Solana native deposits can sweep to hot0 safely. Unknown or reorged attempts cannot trigger duplicate spends or premature resource release.

## Phase 5 — Hot-wallet withdrawals

- [ ] **P5-01** Add logical withdrawal models and `withdrawals/` module, including customer/domain, destination, principal, accepted fee quote, scoped idempotency key/digest, Ledger hold, hot generation, status/reason, and linked attempts.
- [ ] **P5-02** Add withdrawal request/status APIs with exchange-backend authentication, customer ownership validation, and canonical amount/destination checks. Reject exchange-owned deposit/hot/management destinations and conflicting customer-scoped idempotency payloads.
- [ ] **P5-03** Restrict the existing customer-wallet transaction route and internal management/signing interfaces. Customer requests must not choose a source wallet, path, nonce, UTXOs, or deposit-wallet fallback.
- [ ] **P5-04** Implement the reservation saga through durable commands/results. Persist intent before requesting a hold; recover lost result delivery and rejected or orphaned reservations.
- [ ] **P5-05** Implement hot liquidity checks and durable scheduling. Queue many logical withdrawals while executing one active hot transaction; report insufficient liquidity separately from insufficient customer balance.
- [ ] **P5-06** Prepare/sign/broadcast only from the registered hot wallet. Revalidate destination ownership and authorization at execution/signing, including registry changes since request acceptance.
- [ ] **P5-07** Settle confirmed withdrawals once with actual fees; release safe unsubmitted cancellations. Preserve holds for signed/possibly submitted/unknown attempts and settle fees on failed on-chain execution according to policy.
- [ ] **P5-08** Implement withdrawal post-settlement reorg compensation and obligation/hold restoration. Replacements reuse the logical operation and hold; reconcile old-attempt confirmation before any new payout.
- [ ] **P5-09** Verify concurrent requests, low balance/liquidity, idempotency conflicts, cancellation races, authorization changes, lost responses, late/superseded confirmation, duplicate settlement, and outgoing reorg recovery.

**Gate:** every customer withdrawal is paid from hot0 with one logical hold and one payout. Queue backlog, failures, replacement, and cancellation cannot overspend or release funds prematurely.

## Phase 6 — ERC-20, SPL, and fee management

- [ ] **P6-01** Verify installed Wallet Core/protobuf capabilities with signed fixtures for ERC-20 and sponsored/multisigner SPL transactions. Choose an explicit compatible implementation where required before enabling either adapter.
- [ ] **P6-02** Implement typed ERC-20 preparation/signing and decoded recipient validation against the registered hot address for sweeps; distinguish the token contract from the asset recipient.
- [ ] **P6-03** Implement capped, idempotent management-account-1 gas funding with balance/resource reservations, confirmation dependencies, and budget limits. Internal funding must be identifiable before its event reaches Ledger.
- [ ] **P6-04** Order token sweeps before remaining native drain; account for actual gas and repair residual native/token balances. Avoid repeated funding of the same pending sweep.
- [ ] **P6-05** Implement SPL owned-account discovery, checked mint/program/precision validation, transfers to hot-owned token accounts, and hot account creation/rent handling.
- [ ] **P6-06** Implement authorized separate Solana fee payer/multiple signatures and explicit account-closure policy; independently verify signatures and decoded instructions.
- [ ] **P6-07** Implement hot-wallet ERC-20/SPL withdrawals, native fee liquidity checks, and token/native resource holds using the existing reservation/settlement saga.
- [ ] **P6-08** Certify allowlisted token semantics; leave fee-on-transfer, rebasing, frozen/delegated, NFTs, and unsupported Token-2022 extensions in visible exception states until individually supported.
- [ ] **P6-09** Verify each enabled token end to end: deposit identity/credit, gas sponsorship, sweep recipient, hot ownership, withdrawal, actual-fee postings, expiry/reorg recovery, and unsupported behavior.

**Gate:** each enabled asset can be deposited, credited, swept, and withdrawn. Native-only delivery does not complete the supported-token scope.

## Phase 7 — Operational recovery and controls

- [ ] **P7-01** Implement periodic hot/management RPC reconciliation while keeping provider subscriptions scoped to deposit addresses. Detect transactions that bypass the application.
- [ ] **P7-02** Reconcile verified custody against customer liabilities, equity, fees, deficits, and in-transit/reconciliation accounts per asset/network; persist explanations and unresolved differences.
- [ ] **P7-03** Add repair workers for missed sweep triggers, orphan holds, stalled attempts, stale projections, and interrupted settlements. Make repair idempotent and preserve financial history.
- [ ] **P7-04** Add incident review, quarantine/freeze, safe retry/cancellation, and management-funding controls through authenticated internal/admin interfaces with audit records.
- [ ] **P7-05** Add metrics/alerts for credit latency, unswept value/age, gas backlog, dust, hot available/reserved liquidity, withdrawal age, nonce/UTXO holds, reorg exposure, registry lag, and custody differences.
- [ ] **P7-06** Document recovery/runbooks for provider gaps, Redis/process outages, unknown broadcasts, reorgs, low liquidity, and unexpected outflows. Distinguish initial development reset from ongoing financial recovery.

**Gate:** custody differences and stranded work are visible and recoverable without deleting operations, holds, or journals.

## Phase 8 — Acceptance and controlled rollout

- [ ] **P8-01** Run integration tests with real PostgreSQL/Redis and deterministic RPC/provider fixtures for duplicate/reordered delivery, crash boundaries, concurrency, isolation, reorgs, and stale reset jobs.
- [ ] **P8-02** Run regtest/local-validator/testnet signed-transaction smoke tests for every enabled native/token adapter; verify recipients, fees, resource usage, and final settlement.
- [ ] **P8-03** Demonstrate deposit → customer credit → sweep → hot withdrawal, including management fee funding, unchanged balance after sweep, queued low-liquidity withdrawal, and ledger reconciliation.
- [ ] **P8-04** Exercise recovery after worker/Redis outages, reservation-event loss, provider replay, ambiguous submission, and late confirmation. Confirm no duplicate payout/credit or unsafe hold release.
- [ ] **P8-05** Add separate switches for address issuance, credit, sweeps, and withdrawals; validate dry-run scheduling and a single-domain/chain canary before expanding assets/networks.
- [ ] **P8-06** Record acceptance evidence and rollout/rollback procedures that preserve published addresses, operations, reservations, and journals. Enable only certified asset capabilities.

**Gate:** all required phases pass their checks; enabled assets reconcile end to end; rollout and recovery preserve financial state.

## Phase 9 — Optional follow-up backlog

These tasks increase throughput or scope after the core exchange flow is accepted. They are not prerequisites for the initial serialized hot-wallet scheduler.

- [ ] **P9-01** Add bounded EVM nonce windows plus native/token liquidity reservations; remove serialization only after concurrent execution and replacement tests pass.
- [ ] **P9-02** Add Bitcoin withdrawal batches with immutable output-to-withdrawal mappings, fee attribution, reserved UTXOs, and hot-owned change. Certify multi-source/multi-key sweep aggregation separately.
- [ ] **P9-03** Add supported Solana withdrawal batching/concurrency with source/token/fee reservations, account-contention limits, instruction-size limits, expiry, and per-withdrawal attribution.
- [ ] **P9-04** Evaluate an EVM batch-contract/smart-account adapter with independent approval and certification before enabling it.
- [ ] **P9-05** Add multiple technical custody domains/seeds with isolated signing routes, and safe generation rotation that continues monitoring funded older addresses. Keep the single-exchange ownership model.
- [ ] **P9-06** Add an explicit internal-transfer API with atomic liability transfers if exchange-owned destinations should be supported.
- [ ] **P9-07** Extract Treasury into a separate NestJS application/database if operational load warrants it; preserve queue contracts and database ownership.

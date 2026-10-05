# Exchange wallet implementation TODO

Updated: 5 October 2026

Status: Phase 0–1 implementation and isolated reset/bootstrap verified; coordinated deployment reset and live provider/execution rollout gates remain pending

Design reference: [Exchange wallet implementation plan](exchange-wallet-implementation-plan.md)

Initial configuration and worker answers: [implementation decisions](exchange-wallet-initial-decisions.md). The target is one exchange per deployment, with no tenant model.

Current audit: [Phases 1–3 review](exchange-wallet-phases1-3-review.md), 5 October. R1/R2/R6/R7 are fixed with regression coverage and the expanded 250-test suite passes. Phase 1 custody/bootstrap/issuance is implemented and verified locally. P0-07/P1-07 deployment reset and P3-02 external provider acceptance remain open. See [Phase 1 implementation notes](exchange-wallet-phase1.md).

## How to work through this checklist

- Work through phases 0–8 in order. Phase 9 contains optional follow-up work.
- Use the task IDs when discussing, implementing, or reviewing work. Start with **P0-01**.
- Mark a task complete only when its implementation and relevant verification are complete. Record blockers or implementation links beneath the task.
- Complete each phase's gate before enabling the next customer-facing capability. Preparatory work can run in parallel when its prerequisites are ready.
- Existing development records can be discarded. Use a coordinated reset; no legacy-address or opening-balance migration is required.

| Phase | Deliverable                                    | Prerequisite | Status                                                               |
| ----- | ---------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| 0     | Agreed configuration and contracts             | None         | Implemented/tested; coordinated deployment reset pending             |
| 1     | Custody roles, allocation, and clean bootstrap | 0            | Implemented/tested; deployment reset/bootstrap pending               |
| 2     | Durable messaging and exchange accounting      | 1            | Implemented/tested; Phase 1 rollout prerequisite pending             |
| 3     | Deposit detection, credit, and customer APIs   | 2            | Local implementation/tested; Phase 1 and P3-02 external gate pending |
| 4     | Safe execution and native sweeps               | 3            | Pending                                                              |
| 5     | Hot-wallet withdrawals                         | 4            | Pending                                                              |
| 6     | ERC-20 and SPL lifecycle support               | 5            | Pending                                                              |
| 7     | Operational recovery and controls              | 6            | Pending                                                              |
| 8     | End-to-end acceptance and rollout              | 7            | Pending                                                              |
| 9     | Optional throughput and domain expansion       | 8            | Backlog                                                              |

## New direction foundations — User and Sweep

These changes implement the 5 October service-boundary decision. Phase 1 custody bootstrap is now implemented; Phase 4 fund execution remains separate. Ledger settlement incidents now reach Sweep independently under P2-02/P4-00. Only User and Wallet publish application HTTP ports; workers use authenticated queues and Ledger retains authenticated private HTTP reads.

- [x] **U-01** Add a separate User NestJS application and Prisma/PostgreSQL database. Register email/password with normalized unique email, salted asynchronous scrypt, bounded hashing, safe body/error handling, and registration throttling. Login/access-token issuance is implemented under U-05; sessions/refresh/revocation remain U-06.
- [x] **U-02** Atomically publish secret-free `user.registered.v1` from User; provision matching Wallet customer UUID/external ID, durable receipt, and Ledger identity command together. Remove direct backend customer registration and reserve User UUID identities. Wait for Ledger acknowledgment before balance/address readiness; replay cannot clear freezes.
- [x] **U-03** Remove runtime tenant models, DTO/message fields, auth context, key maps, and tenant scopes. Use one `WALLET_API_KEY`, separate exchange/Ledger credentials, globally scoped external wallet identity, and wallet-scoped transaction idempotency. Preserve historical migrations; additive Wallet/Ledger migrations reject conflicting global development identities instead of merging them.
- [x] **U-04** Register User and Sweep in build/watch/start/migration tooling, Compose, CI, database isolation, and coordinated reset targets. Prepare configuration examples without modifying deployment secrets or resetting application data.
- [x] **U-05** Add email/password login and short-lived RS256 access tokens. User holds the private token key; Wallet verifies with only the public key, issuer/audience, expiry, UUID subject, and reset epoch. Public `/v1/me` routes derive customer identity from the token; service keys and customer JWTs cannot substitute for each other. Registration responses contain identity fields only. Verify generic login failures, missing-account hashing, independent throttles, provisioning lag, and cross-customer rejection.
- [ ] **U-06** Extend identity with refresh/session revocation/logout, verified email, password recovery, MFA, and coordinated key rotation. Deploy shared edge/distributed registration/login limits before scaling public authentication across replicas.
- [x] **U-07** Move Wallet operations to authenticated `/internal` routes, exclude them from public OpenAPI, and remove Ledger registration side effects from HTTP balance reads and remove its direct wallet registration HTTP route. Add a development Compose application overlay publishing only User/Wallet with separate owned database credentials and scoped token/custody secret mounts. Document public-ingress path restrictions and host UID/GID for owner-only secret files.

See [architecture](architecture.md) for current boundaries and [implementation plan](exchange-wallet-implementation-plan.md) for execution ownership.

**Verification (5 October):** 231 tests passed with no failures/skips across six dedicated service databases and Redis, including User → Wallet → Ledger provisioning/login/JWT ownership, reversal-first settlement fencing, pending re-inclusion compensation/uncertainty, certified-network recovery fairness, and identical Wallet/Sweep incident delivery with sticky gates. Build, ESLint, formatting, Compose configuration, and diff checks passed. Migrations applied only to isolated test databases; deployment records and secrets were not modified. The Compose application image/startup was not exercised. Full Sweep/withdrawal execution, session features, deployment reset/bootstrap, and live QuickNode certification remain later gates.

## Phase 0 — Configuration and contracts

- [x] **P0-01** Apply the initial single-exchange decisions: globally unique customer external IDs, one development seed, Sepolia, Bitcoin regtest, and Solana Devnet; one network per chain. Record the configured seed identifier and verify each RPC identity before enabling its adapter. Development profile and mocked identity checks are recorded; live RPC checks remain pending. P1-05 now supplies tested regtest derivation, signing and mocked RPC identity checks; live deposit/execution enablement remains gated.
- [x] **P0-02** Confirm the derivation convention: hardened `Wallet.account` 0 for hot, 1–9 reserved for management, and customer accounts starting at 10. Define account 1's gas/fee purpose and limits. Per-chain derivation paths and management budgets are recorded; signer fixtures verify accounts 0, 1, 9, and 10. P1 now enforces roles, reserved indices, and allocator boundaries in the application and PostgreSQL.
- [x] **P0-03** Define canonical asset metadata and adapter capabilities, including native assets, allowlisted ERC-20/SPL assets, decimals, token identity/program, and unsupported-asset handling. The decisions record now defines `(chain, network, asset_id)`, native and token ID forms, pinned metadata, lifecycle certification gates, conservative ERC-20/SPL scope, and custody-exception behavior. Runtime registry and enforcement remain later implementation work.
- [x] **P0-04** Implement/version the financial defaults in the decision record: Ethereum finalized blocks, Bitcoin 6 confirmations, Solana finalized, positive base-unit credit, sweep economics, fee/rent/funding caps, zero development customer withdrawal fee, cancellation fences, and deficit handling. Require hot liquidity before execution. `exchange-financial-v1` is the normative development policy; accepted operations retain their policy version, and withdrawal signing/submission requires atomic hot0 liquidity reservations.
- [x] **P0-05** Define operation/attempt state machines and versioned queue contracts, including registry acknowledgments, deposit credit/reversal, reservation, execution, settlement, release, and incidents. The implementation plan separates business schema versions from the HMAC transport envelope and specifies event identities, outbox/inbox delivery guarantees, aggregate transitions, and cancellation/reorg safety. Shared runtime schemas are implemented in P2-01.
- [x] **P0-06** Confirm RPC/indexer/provider capabilities for deposit subscriptions, transfer identities, historical backfill, Bitcoin UTXO discovery, and Solana token accounts. Record required changes in the external provider. Source review confirms webhook intake but no wallet-watch lifecycle/backfill cursor or Bitcoin UTXO adapter, and identifies lost BTC/EVM/Solana transfer identity/base-unit details. QuickNode is selected for Ethereum and Solana; Helius is deprecated. Deployed QuickNode capabilities remain pre-enable gates because credentials/config are unavailable here.
- [ ] **P0-07** Complete the coordinated deployment reset. **Tooling and rehearsal complete:** six explicit distinct service databases, loopback endpoint validation, durable epoch/namespace plan, exclusive owner-token lock, startup fence, failure/resume, project-only Redis/Pub/Sub cleanup, and stale queue/provider rejection. `npm run rehearse:reset` verified real six-database resets and two custody bootstrap rounds, first customer account 10, stable hot addresses and empty liabilities. **Remaining:** reset the actual development deployment after its missing database/auth/reset configuration is supplied and the external publisher/watch retirement is verified. The tool requires factual `--workers-stopped --publisher-stopped --provider-watches-removed` acknowledgments; provider changes and service startup remain operator steps.

**Gate:** configuration and contracts are recorded; external dependencies are known; the reset procedure can be run once the updated schemas are ready.

## Phase 1 — Custody roles, allocation, and bootstrap

- [x] **P1-01** Add Wallet-owned Prisma models for custody domains/networks, wallet roles, approved management purposes/spending caps, and pinned asset configuration; retain existing registry/readiness projections. Seed material remains outside PostgreSQL. Additive migration preserves historical migrations and all six application databases remain separate.
- [x] **P1-02** Enforce hot0, management1–9, customer >=10, one active hot/customer wallet per network, canonical addresses, and seed/chain/account uniqueness. Composite customer/domain/epoch ownership and same-generation hot destination are enforced by PostgreSQL; derivation/published identity cannot be reassigned.
- [x] **P1-03** Start the customer sequence at 10, bounded at 2147483647 with no cycling. Advisory transaction locks serialize replica allocation; reserved inserts do not consume it. Real PostgreSQL tests verify concurrent allocation, final supported account, and a clear exhaustion error.
- [x] **P1-04** Implement idempotent `custody/` bootstrap and explicit approved management creation, with authenticated queued commands under `/internal/custody`. Public assignment persists intent and queues issuance; Wallet owns allocation and atomic Signer outbox creation. Bootstrap replay repairs pending issuance in bounded pages.
- [x] **P1-05** Bind derivation commands/results to wallet/request IDs, digest, domain, seed, chain, network, role/account and exact expected path. Signer validates configured identity; Wallet rejects mismatched results and validates canonical addresses. Bitcoin regtest uses BIP84 coin1, bcrt SegWit addresses, independently verified transaction scripts/signatures, and node identity checks. Mainnet/regtest confusion is rejected.
- [x] **P1-06** Hide addresses until owned derivation/publication, customer Ledger registration, hot0/management1 registration, and current listener acknowledgment with complete backfill coverage. Runtime seed/domain/epoch, active custody configuration/network, native observation/credit flags, ownership and registry revisions must agree. Native capability flags do not certify live rollout.
- [ ] **P1-07** Execute reset/bootstrap on the actual development deployment. The isolated six-database rehearsal already verifies two rounds, deterministic hot0, approved management1, first customer account10, empty Ledger liabilities, and stale-work fences. Actual deployment `.env`/records/seed have not been changed; missing configuration and external publisher/watch status remain outstanding.
- [x] **P1-08** Verify concurrent bootstrap/allocation, reserved-role rejection, ownership and seed/network isolation, immutable published identity/configuration, allocator exhaustion, repeated real reset/bootstrap and stale epoch rejection. Real NestJS HTTP/Redis workers also bootstrap and derive customer addresses while withholding readiness until acknowledgments.

**Gate:** custody allocation/bootstrap is implemented and verified locally. Deployment acceptance remains open at P0-07/P1-07 and live RPC/provider certification. Generic transaction APIs reject authoritative custody wallets until Phase 4/5 supply authorized execution.

**Verification:** 250 tests pass with no failures/skips; the real isolated six-database reset/bootstrap rehearsal, build, ESLint, formatting, Compose configuration and diff checks pass. See [Phase 1 implementation notes](exchange-wallet-phase1.md) for code mapping, commands, tests and remaining environment requirements.

## Phase 2 — Durable messaging and exchange accounting

- [x] **P2-01** Implement the shared versioned contracts in `packages/queue`, with domain/customer, canonical asset/network, operation/attempt IDs, request digest, correlation/causation IDs, revision, and schema version. `packages/queue/src/exchange-contracts.ts` now provides strict `schemaVersion: 1` runtime schemas for registry, deposit/deficit, reservation/release, execution, settlement, and incident events. Producer/consumer routing and transactional fan-out are implemented in P2-02.
- [x] **P2-02** Add explicit outbox fan-out to consumer-owned queues. Deliver registry events separately to Ledger and ActivityListener; persist acknowledgments. Retain database inbox deduplication and transition guards beyond queue retention. R7 fixed: settlement fee-cap/custody-shortfall/reorg incidents now atomically deliver identical payloads to Wallet and Sweep, including customer identity when omitted by the settlement input.
- [x] **P2-03** Extend Ledger's Prisma schema with metadata-only `LedgerAccount` identities/types/owners, journal batches independent of on-chain activities, deposits, withdrawal reservations, operation/journal links, inbox records, and its own transactional outbox. Keep balances in append-only entries; wire the Ledger outbox relay.
- [x] **P2-04** Implement Ledger feature boundaries for accounts, deposits, reservations, and settlements. Preserve immutable balanced journals, sequence locking, predecessor links, and compensating-entry references.
- [x] **P2-05** Separate physical custody accounts from customer pending/available/reserved/frozen liabilities. Use bounded integer base units and separate balances for each asset/network; exclude in-transit custody from spendable hot liquidity.
- [x] **P2-06** Implement final-deposit credit exactly once and pending/final/reverted transitions. Atomically publish `deposit.credited` with its journal entry; add deficit/freeze handling when reversing funds already withdrawn.
- [x] **P2-07** Implement atomic balance-check-and-reserve, idempotent release, and reservation result events. Reserve principal plus the accepted customer fee, using separate holds when fee assets differ.
- [x] **P2-08** Implement custody-only sweep/funding postings and withdrawal settlement, actual native network fees, accepted fee revenue, failed-on-chain fees, and versioned settlement reversals. Unknown outcomes retain holds. R1 fixed: independent durable reversal fences accept reversal before execution/settlement, block stale settlement/release, and preserve a hold without creating a fictitious compensating journal. A higher canonical re-inclusion can settle the same attempt once.
- [x] **P2-09** Add reservation reconciliation for missing operations/events and expose authenticated customer balance reads through Ledger. Keep all applications on their own databases.
- [x] **P2-10** Verify concurrent holds, duplicate/reordered events, unchanged customer liability for sweeps/funding, per-asset balanced journals, and reservation/outbox crash recovery. Added R1 pre-intent/reversal-first/conflicting-identity/crash regressions and R7 independent identical incident delivery and sticky Sweep review gates.

**Gate:** Ledger owns customer balances/holds and journals are balanced without cross-application database reads. R1 reversal ordering and R7 incident fan-out are fixed and tested; Phase 1 deployment readiness remains a prerequisite. Consumer retry exhaustion currently requires retained-job/manual recovery; see the review's additional recovery limitations.

**Verification:** initial Phase 2 verification passed 122 tests; the latest whole-repository run passes 250 tests with no failures/skips, including the new R1/R7 regressions. Application/tooling build, ESLint, formatting, and diff checks passed. See [Phase 2 implementation notes](exchange-wallet-phase2.md) for code mapping, APIs, migrations, and verification setup. Phase 1 deployment reset/bootstrap and Phase 3 provider readiness still gate customer-facing deployment. Application data was not reset and deployment databases were not migrated.

## Phase 3 — Deposit listener and customer deposit APIs

- [x] **P3-01** Implement listener registry projections, revision checks, readiness acknowledgments, rebuilds, fenced watch generations, registry locks, and historical cursor recovery. Gaps/rebuilds pause financial processing. R6 fixed: recovery and stale watch cleanup select certified eligible networks before the batch limit; disabled rows cannot starve eligible work. Certificate removal/restoration is covered.
- [ ] **P3-02** Implement provider subscription installation/removal, acknowledgment persistence, start block/slot, and backfill cursors. **Client implementation complete here:** QuickNode Ethereum/Solana and separate Bitcoin Core regtest gateway routes, durable install/cleanup leases, paginated backfill from address history, and certificates disabled by default. **Remaining:** implement/deploy the [gateway protocol](exchange-wallet-phase3.md#quicknode-gateway-contract) in the separate provider repository and certify deployed watch lifecycle, historical coverage, raw units, stable discovery/transfer identities, canonical RPC/trace coverage, and current-epoch delivery. Relevant SPL token-account watches remain Phase 6 enablement work under the native-first rollout.
- [x] **P3-03** Treat provider notifications as discovery signals; verify network and canonical chain data through RPC before publishing normalized financial observations. Strict signals cannot supply amounts, owners, or confirmation counts; canonical RPC reconstruction determines finality and financial data.
- [x] **P3-04** Replace transaction-level balance-change identity with transfer identity: Bitcoin `txid:vout`, ERC-20 transaction/log index, EVM native transfer/trace identity, and Solana instruction/inner-instruction plus token identity. Native financial posting is enabled only with complete verification; token observations remain visible exceptions until Phase 6.
- [x] **P3-05** Classify external deposits, internal funding, persisted authorized sweeps, and unexpected outflows. Trusted registry and operation attempts distinguish external receipts from funding, hot receipts, change, and refunds without requiring an unrelated external counterparty to be registered.
- [x] **P3-06** Publish observed/finalized/reverted deposit events and maintain Wallet history from Ledger results with consistent normalization and separate discovery/accounting revisions. R2 fixed: retain finalized inclusion independently of replacement pending observations; compensate proven old inclusion orphaning before replacement finality. RPC uncertainty preserves accepted evidence/credit, and incomplete pending data cannot erase it.
- [x] **P3-07** Persist unexpected customer-wallet outflow incidents, freeze liabilities, and journal custody loss against exchange reconciliation. Reorgs and later known sweep purpose compensate provisional loss without silently changing liability or unfreezing. Match source, native asset, hot destination, amount, attempt/hash, and fee payer; fee-cap breaches freeze for policy review while settlement accounts for actual cost once. Incomplete native observations freeze proven customer spends without guessing a net loss.
- [x] **P3-08** Add idempotent deposit-address assignment, balances, and scoped deposit-history APIs. Public `/v1/me` derives the customer from the User JWT; administrative `/internal/customers` uses a separate service key. User registration provisions customer UUID/Ledger registration asynchronously; direct backend creation is removed. Balances return HTTP 202 until acknowledged. Public assignment accepts only the configured Sepolia, Bitcoin regtest and Solana Devnet profile and waits for custody derivation and all coverage prerequisites.
- [x] **P3-09** Verify replay, exact output/log/instruction identities, normalization, out-of-order finality, registry lag, backfill, lost acknowledgments, and reorgs with deterministic fixtures and isolated PostgreSQL/Redis. Funding, hot receipts, change, and refunds cannot mint another credit. Added R2 different-block pending/no-inclusion/incomplete/uncertain re-inclusion and R6 mixed-network recovery/cleanup/certification regressions. Live provider acceptance remains P3-02.

**Gate:** existing verification covers many native credit, registry, and readiness cases. R2 re-inclusion and R6 recovery fairness are fixed and tested. The rollout gate also remains **open** until the Phase 1 deployment reset/bootstrap and P3-02's external provider implementation/certification pass. No application records were reset or deployment databases migrated. See [Phase 3 implementation notes](exchange-wallet-phase3.md) for APIs, additive migrations, configuration, and external gateway responsibilities.

**Verification:** initial Phase 3 verification passed 190 tests; the latest whole-repository run passes 250 tests with no failures/skips using six dedicated service PostgreSQL databases and Redis plus deterministic RPC/provider fixtures. Application/tooling build, ESLint, Prettier, and diff checks passed. Live QuickNode gateway tests were not run; they remain part of P3-02 certification.

## Phase 4 — Safe execution and native sweeps

- [x] **P4-00** Establish separate `apps/sweep` with its own database, queue, durable inbox/outbox, trusted registry projection, credited-deposit coalescing, reversal tombstones, and sticky customer/domain review gates. No signing/submission command is emitted; registry-ready work remains `blocked_execution_not_implemented`. R7 fixed: Ledger settlement incidents have independent identical Sweep delivery with sticky gate regression coverage. Full execution remains P4-01–P4-12.
- [ ] **P4-01** Add logical sweep, attempt, funding, and scheduling/resource-claim saga models in Sweep. Persist operation revisions, hot generation, deferral reasons, retry time, and immutable attempt/replacement lineage. Acquire Wallet's authoritative source execution fence through queues rather than importing its application or reading its database.
- [ ] **P4-02** Implement source execution reservations before preparation/signing. Retain `one_pending_per_wallet`; signed, submitted, and uncertain attempts keep their slot until reconciliation proves it can be released.
- [ ] **P4-03** Implement trusted Signer policy authorization independent of queue HMAC. Verify source derivation/role, configured purpose, asset/network, destination, fee/output bounds, authorization expiry/policy revision, and request digest; bind results to the attempt and derive keys only in memory.
- [ ] **P4-04** Extend prepare/sign/broadcast contracts and Broadcast persistence with operation/attempt references and settled fee/result information. Validate signer-result digest/revision/state, then automatically enqueue broadcast through Wallet's outbox while preserving immutable signed snapshots and same-byte retries.
- [ ] **P4-05** Complete Sweep scheduling from `deposit.credited`: durable coalescing is implemented under P4-00; now re-read canonical resources, reserve inputs, apply sweep-consumption generations, and defer insufficient funds/gas or uneconomical dust. Credited planning units are not spendable chain balances. Arrivals during an active attempt become later work.
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
- [ ] **P5-02** Add JWT-authenticated withdrawal request/status APIs under `/v1/me/withdrawals`, deriving customer identity from the verified subject. Keep administration under service-authenticated `/internal`. Validate canonical amounts/destinations, reject exchange-owned addresses, and reject conflicting customer-scoped idempotency payloads.
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

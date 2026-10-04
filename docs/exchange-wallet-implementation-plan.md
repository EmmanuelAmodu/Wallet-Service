# Exchange wallet infrastructure implementation plan

Date: 4 October 2026  
Repository reviewed: `08f07c3`  
Status: implementation proposal; this document does not change application behavior.

Track implementation in the [phased TODO checklist](exchange-wallet-todo.md). This document remains the design reference.

Use the [initial implementation decisions](exchange-wallet-initial-decisions.md) for the single-exchange identity model, development networks, financial defaults, provider dependencies, management budgets, and Ledger account representation.

Development assumption: existing application records can be discarded. Implement the exchange schema against clean service databases, with no legacy-address or balance migration.

## 1. Target behavior and decisions

Transform the current wallet-as-a-service monorepo into exchange custody infrastructure:

- Derivation account **0** is the hot wallet for each enabled chain/network in an exchange custody domain.
- Accounts **1–9** are reserved for management wallets. Account 1 is the gas/fee wallet for EVM and Solana; Bitcoin account 1 remains unallocated. Accounts 2–9 remain unused until an explicit purpose is configured.
- Newly created customer deposit wallets use accounts **10 and above**.
- Finalized, eligible assets received by customer deposit wallets are swept to the configured hot wallet.
- Customer withdrawals are paid exclusively from that hot wallet. Customers do not choose a source wallet, derivation path, nonce, or UTXOs.
- The provider listener subscribes to customer deposit addresses and examines both their deposits and their outgoing movements. The only authorized asset destination for a customer-wallet outflow is its registered hot wallet; transaction fees are accounted for separately.
- Customer exchange balances survive sweeping. They represent what the exchange owes the customer, independently of the address holding the assets.

### Explicit interpretations and proposed defaults

1. **Index means the existing `Wallet.account` derivation account.** `walletCoreMetadata()` replaces the hardened account component of the Wallet Core path. It does not change the final receiving-address index. Preserve this convention rather than silently introducing another derivation scheme.
2. **A hot wallet belongs to the exchange, not to an individual customer.** Use one exchange per deployment and remove tenant ownership. Identify customers by internal UUID and globally unique `external_id`. Retain a technical custody domain/generation for seed/network configuration, with a hot wallet per enabled chain/network.
3. **Network isolation must respect key identity.** The existing unique key `(seed_id, chain, account)` means one seed cannot create separate rows at account 0 for the same chain on multiple networks. Use a distinct custody seed/domain for those networks initially. Do not bypass the constraint and treat the same key as two unrelated wallets.
4. **Credit at deposit finality; sweep afterward.** Under `exchange-financial-v1`, a finalized deposit becomes available before its sweep finishes. A withdrawal may queue while a sweep supplies liquidity, but signing/submission waits until hot0 has atomically reserved payout principal in the withdrawal asset and worst-case native execution fee in the network's fee asset. Customer deposits, management balances, and in-transit custody are not hot liquidity. Production changes require a new reviewed policy version.
5. **All assets means all explicitly supported assets.** Native coins are the first delivery milestone, followed by allowlisted ERC-20 and SPL tokens. Unknown tokens, NFTs, unusual token extensions, and unsweepable dust enter a visible exception state. The project must not advertise support for an asset that it can record but cannot sweep and withdraw.
6. **Fees cannot be swept as assets.** Sweep the maximum economically transferable amount, retain only required fee/rent reserves where necessary, and rescan for residuals. Start with exchange-paid network costs and zero customer withdrawal fee in development, within the documented budgets. Persist the fee quote accepted by the customer even when it is zero.
7. **The five current applications remain.** Add exchange orchestration as NestJS feature modules in `apps/wallet` initially. Keep Signer stateless, Broadcast responsible for signed-byte submission/retries, ActivityListener responsible for deposit-address observations, and Ledger responsible for financial state. A separate Treasury application can be extracted later if operational load justifies its own database.

## 2. Current implementation and required changes

| Current component | Existing behavior | Exchange change |
| --- | --- | --- |
| `apps/wallet/src/wallets/wallets.service.ts` | Allocates accounts using the global `wallets_account_seq`; creates customer-associated addresses | Bootstrap management wallets explicitly; allocate customer accounts from 10; persist roles and custody domains |
| Wallet baseline migration | `wallets_account_seq` restarts at 0 | Update the development baseline so customer allocation starts at 10; bootstrap hot0 explicitly after reset |
| `packages/chain/src/coin-metadata.ts` | Uses Wallet Core metadata and substitutes the hardened account component | Keep derivation compatible; add fixtures for account 0, reserved accounts, and account 10 on each enabled chain |
| `apps/wallet/src/transactions/transactions.service.ts` | Accepts a caller-selected wallet and transfer parameters; permits one pending transaction per wallet | Replace the customer flow with logical withdrawals; schedule operational transactions from the hot wallet or an approved sweep source |
| `apps/wallet/src/messaging/wallet-workflow.service.ts` | Prepares transactions and records signer results; broadcast is requested separately | Automatically enqueue broadcast for authorized sweep/withdrawal operations after signing |
| `apps/signer/src/signing/signing.core.ts` | Derives keys and signs native transactions after validating address/path/network | Enforce operation purpose, source role, and destination policy; add explicit token and sweep signing adapters |
| `apps/broadcast/src/broadcast/broadcast.service.ts` | Stores immutable signed snapshots; reconciles hashes, retries, and monitors confirmations | Preserve this behavior; propagate operation/attempt identifiers and actual settled fee/result information |
| `apps/activity-listener/src/activity-workflow.service.ts` | Publishes transaction-level balance changes and tracks finality/reorgs | Classify individual deposit transfers, recognized sweeps, funding, and unexpected outflows against a trusted address registry |
| `apps/ledger/src/ledger.service.ts` | Journals address custody balances against clearing accounts | Add customer liabilities, withdrawal reservations, deposit credit identity, internal custody transfers, and business events |
| `apps/wallet/src/ledger/ledger-client.service.ts` | Reads address balances; registers wallets on balance reads | Return customer exchange balances; use explicit durable registration and reservation workflows |
| `packages/queue/src/messages.ts` | Authenticated BullMQ envelopes and action/result contracts | Add versioned deposit/sweep/withdrawal contracts and durable consumer deduplication |

Use the development reset workflow described in `README.md` to recreate the Wallet, Broadcast, and Ledger databases with the exchange schemas. Reset their associated queues and listener state together so old work cannot run against newly created records. There is no requirement to preserve current development wallets, transactions, or balances.

## 3. Wallet roles, ownership, and derivation allocation

### Proposed Wallet database models

| Model | Essential fields and constraints |
| --- | --- |
| `CustodyDomain` | Technical exchange custody generation, seed identifier, enabled chain/network configuration, operational status; private seed material remains outside PostgreSQL |
| `Wallet` extensions | `custody_domain_id`, `role`, optional `customer_id`, `active`, and configuration revision; roles: `hot`, `management`, `customer_deposit` |
| `ManagementWalletPurpose` | Reserved account, purpose, permitted actions, funding limits; internal administration only |
| `AddressSubscription` | Wallet/address identity, chain/network, subscription status, start block/slot, backfill cursor, provider acknowledgment; SPL token-account addresses mapped to their customer owner |
| `AssetConfiguration` | Versioned `(chain, network, asset_id)` identity, standard, decimals and display metadata, exact contract or token-program-plus-mint identity, certified lifecycle capabilities, finality/fee/threshold policy, and policy version. Symbols are display-only; decimals are verified against pinned configuration. |
| `Customer` or customer mapping | Stable internal UUID plus globally unique `external_id` supplied by the authenticated exchange backend; no tenant model |

Maintain canonical address normalization per chain and immutable seed/account/path ownership once an address is published.

### Allocation rules

- Create account 0 through an idempotent internal `CustodyBootstrapService`, not the public customer-wallet endpoint.
- Insert management accounts explicitly in 1–9; unused reserved accounts need no database row.
- Retain the existing global noncycling allocator initially, with minimum customer allocation 10. Gaps are acceptable; customer numbers need not be consecutive or restart per chain.
- Initialize the customer sequence at 10 in the fresh schema. Use a fixed role-aware customer allocator rather than relying on callers to remember the minimum. Explicit hot/management inserts must not consume or advance the customer sequence.
- Add database constraints for new roles: hot account = 0, management account between 1 and 9, customer deposit account >=10; enforce a unique active hot wallet per custody domain/chain/network.
- Enforce the existing maximum account bound and fail clearly before exhaustion; test allocation under multiple Wallet replicas.
- Hot-wallet bootstrap derives account 0, verifies the returned path/address, records readiness, and publishes its configuration. Customer wallets must not become deposit-ready until their hot destination and subscription are ready.
- Rotation creates a new custody generation/seed with its own account-0 hot wallet. Persist which generation each operation uses; keep old funded addresses monitored until deliberately retired.

### Signer seed configuration

Start with one exchange custody domain and the current single-seed Signer deployment. Bootstrap account 0 and all customer/management accounts from that configured seed. No legacy signing routes are needed after the development reset.

If multiple seed-isolated domains or same-chain networks are enabled later, add isolated Signer deployments/queues per seed or a deliberate vault-backed multi-seed interface. Bind commands/results to domain, seed, network, and operation; different seed workers must not compete on the same queue.

### Development reset and bootstrap

1. Stop application workers and the development provider publisher; remove old provider watches.
2. Review and apply the guarded `npm run reset:development` script. It recreates Wallet, Broadcast, and Ledger local databases from baselines, retires only the previous project BullMQ prefix and Pub/Sub subscription, and rotates the persistent epoch/topic/subscription names.
3. Update the external provider publisher to the new topic/epoch; the reset script cannot configure that separately deployed service. Install fresh watches and verify subscription acknowledgment/backfill before readiness.
4. Configure the development custody seed, networks, assets, and signer policy. A record reset does not clear blockchain state; use fresh local chain state or a fresh development seed when an empty on-chain starting point is required.
5. Bootstrap the hot wallet at account 0, then any explicitly configured management wallets in 1–9. Begin customer allocation at exactly 10.
6. Install/verify customer subscriptions, seed test fixtures deliberately, and start the exchange workers with the new epoch.

## 4. Service responsibilities and NestJS module layout

### Wallet application

Add these feature modules under `apps/wallet/src`:

- `custody/`: domain/role registry, hot-wallet bootstrap, management policy, registry events.
- `customers/`: customer mapping and deposit-address lookup.
- `deposits/`: deposit status projection and customer-facing deposit history.
- `sweeps/`: sweep eligibility, resource reservations, gas-funding dependency, durable scheduling and state transitions.
- `withdrawals/`: customer intent, idempotency, reservation saga, execution queue, and settlement projection.
- `treasury/`: hot liquidity, management funding, physical custody reconciliation, and operational exceptions.

Reuse the existing `transactions/` preparation and execution code behind an internal interface. One logical withdrawal or sweep may have several execution attempts; an attempt is not another customer payment.

### Ledger application

Add `accounts/`, `deposits/`, `reservations/`, and `settlements/` modules as the feature boundary grows. Ledger exclusively owns customer balances and atomic holds. Add its own transactional outbox and wire `OutboxRelay` using the Ledger database; it currently has no outgoing business-event persistence.

### ActivityListener application

Add an address-registry consumer and normalized transfer classifier. A local durable registry can use a small application-owned PostgreSQL database if full replay of Redis state is not operationally acceptable. For the first delivery, a rebuildable Redis projection is sufficient only if processing pauses during rebuild and replay/backfill closes the gap. Never make a missing registry entry mean an ignored deposit.

### Signer and Broadcast

Keep the Signer outside financial database access. Give it a trusted policy configuration/authorization verifier. Keep Broadcast's database and responsibility unchanged in principle: persisted signed bytes, chain submission, retries, confirmation, and result events.

No application reads another application's database. Commands and events use BullMQ; read-only customer balance queries can continue using the existing authenticated internal Ledger HTTP interface.

## 5. Accounting model

Customer liabilities and physical custody must be separate account classes. Reusing the current wallet balance as a user balance would reduce the user balance whenever a sweep runs.

Use the P0-03 canonical `(chain, network, asset_id)` tuple and integer base-unit arithmetic. Asset identifiers are `token:<chain>:native`, `token:<evm-chain>:erc20:<lowercase-contract>`, or `token:solana:spl:<case-sensitive-token-program>:<case-sensitive-mint>`. Network identity remains an explicit tuple field. Native decimals are ETH 18, BTC 8, and SOL 9; token decimals are pinned per allowlist record and verified against the on-chain contract/mint. Symbols are never identity.

An asset can create customer credit only after its adapter certifies exact observation/finality, deposit credit, sweep, and withdrawal. Unsupported or ambiguous provider assets retain evidence in a custody exception; they are never auto-credited or swept. The current listener's free-form token identifiers are discovery input, not authorization. Initial token scope is conventional ERC-20 and classic SPL Token Program assets; fee-on-transfer/rebasing/frozen/delegated semantics and Token-2022 extensions require separate certification.

| Account group | Normal side | Purpose |
| --- | --- | --- |
| Custody: customer deposit, hot, management, in transit | Debit | Where exchange-controlled assets physically reside |
| Customer: pending, available, reserved, frozen | Credit | Amounts owed to a customer and whether they can be withdrawn |
| Network-fee expense | Debit | Fees borne by the exchange |
| Withdrawal-fee revenue | Credit | Customer fees explicitly agreed at request time |
| Equity, deficit and reconciliation accounts | Explicit by account type | Exchange funding and explainable differences |

Use transaction-level custody deltas to prevent temporary double recognition of both spent deposit funds and hot receipts. In-transit balances are reconciled; they are not available hot liquidity.

### Posting rules

- Observed external deposit: record a non-spendable pending observation. Post provisional custody/pending liability only if the reporting model requires it; do not mix this with final spendable balances.
- Finalized deposit: debit deposit custody and credit customer available liability exactly once. If provisional postings exist, reverse/promote them atomically.
- Confirmed sweep: move custody from the deposit account to hot custody; leave customer liabilities unchanged. Record actual network fees in their native fee asset.
- Management-to-deposit gas funding: move custody internally; create no customer credit.
- Withdrawal hold: debit available liability and credit reserved liability for principal plus the accepted customer fee. If the fee is charged in another asset, reserve that asset separately; never combine different asset units.
- Confirmed withdrawal: debit reserved liability for the payout and accepted fee; credit hot custody for the payout, credit fee revenue for the accepted fee, and separately debit fee expense/credit hot native custody for the actual network fee.
- Definitive rejection/cancellation before any spend: return reserved liability to available. Unknown RPC outcomes keep the reservation until reconciliation establishes the result.
- Failed on-chain transaction: release unpaid principal according to the persisted policy, while recording any fee actually paid. Never classify an unknown transaction as a definitive failure.

Deposit reorgs reverse the appropriate credit through compensating entries. If the customer already withdrew the funds, freeze the affected account and record an explicit deficit/debt workflow; do not conceal the difference or manufacture available balance.

### Reorgs after outgoing settlement

A previously confirmed sweep or withdrawal can lose canonical settlement. Add settlement observation revisions and post-settlement checks/reconciliation rather than treating `confirmed` as permanently immutable business truth. The existing terminal Broadcast/Wallet guards need explicit reconciliation transitions for this.

For a reorged sweep, compensate the custody move and reassess its inputs/balances; customer liabilities remain unchanged. For a reorged withdrawal, compensate settlement and retain or restore the logical payment obligation/reservation while establishing whether the original attempt can still confirm. A mempool reappearance is not a safe reason to issue a second payment. Retry/replacement requires proof and linked attempt handling so a delayed old confirmation cannot pay or debit twice.

### Ledger persistence

Extend the Ledger schema with a metadata-only `LedgerAccount` for immutable type/owner/asset/network identity, journal batches independent of on-chain activities, `Deposit`, `WithdrawalReservation`, operation-to-journal references, inbox deduplication, and outbox events. Journal entries reference the account; balances remain in append-only entries, without a mutable account balance/cursor. Preserve journal sequence locking, predecessor links, immutable entries, and reversal references.

The reservation transaction must atomically check available balance, create the hold, record its idempotency key, and enqueue the result event. A committed reservation cannot be forgotten because Wallet crashes before receiving its event. Add reconciliation for reservations with no corresponding active operation.

## 6. Deposit listener and credit flow

1. Wallet derives a customer account >=10 and publishes `customer-wallet.registry.requested` with customer identity, custody domain, chain/network, address, registry revision, and hot-wallet identity. This is not a customer-ready event.
2. The registry/subscription worker installs the provider subscription, records its acknowledgment, and establishes a backfill cursor. The provider is external to this repository, so subscription and payload changes are an implementation dependency.
3. Wallet publishes `customer-wallet.ready` only after both Ledger and ActivityListener acknowledge the matching registry revision and the provider reports complete initial backfill coverage.
4. ActivityListener receives an event carrying the current `RESET_EPOCH` as a discovery signal, verifies the configured network and chain data, and normalizes relevant transfers. Missing or stale epochs are quarantined before queueing.
5. For each watched address, classify the movement as external deposit, internal funding, authorized sweep, or unexpected outgoing activity. Ignore unrelated counterparties for wallet lookup; do not fail the entire event because the external sender has no Ledger wallet.
6. Ledger records pending status, finality promotes the deposit, and Ledger atomically commits the customer credit plus `deposit.credited` to its outbox.
7. Sweep orchestration consumes `deposit.credited`, coalesces eligible work by wallet/asset, and schedules execution.

### Deposit identity and classification

The current flattened `balanceChanges` cannot uniquely identify multiple deposits in one transaction. Extend the provider contract and chain adapters to preserve:

- Bitcoin: transaction hash plus output index.
- EVM token: transaction hash plus log index and canonical token contract; native transfers need an explicit top-level/trace identity and provider/RPC capability for internal transfers.
- Solana: signature plus instruction/inner-instruction identity, token mint/program, destination token account, and its customer owner mapping.

Use those identities with domain, chain, and network in database unique constraints. Retain canonical hash/alias normalization and observation ordering. Replays, several outputs to one address, and independent token/native deposits must not produce duplicate credits.

Exclude management/hot funding from customer deposits using the registry **and persisted funding operation**, including cases where funding confirmation arrives before its operational result event. For known exchange-to-exchange movements, avoid creating a second liability; quarantine ambiguous transfers until classified.

An outbound transfer is an authorized sweep only if it matches a persisted attempt, source, supported asset, amounts/fee bounds, and the registered hot destination. A matching recipient alone is insufficient. For ERC-20 transfers, validate the decoded token recipient rather than the transaction's `to` field, which is the token contract. For Solana tokens, validate the hot-owned token account. Unexpected outflows create a durable incident, freeze the source/domain as configured, and reconcile lost custody without silently subtracting customer liabilities.

The provider listener remains scoped to deposit addresses. Broadcast monitors known hot withdrawals; separate Treasury RPC reconciliation checks hot and management custody and detects transfers that bypass this application.

## 7. Sweep workflow

### Models and state

Wallet database: `SweepOperation`, `SweepAttempt`, optional `SweepDepositLink`, `GasFundingOperation`, and durable execution-resource reservations. Persist source wallet, asset, target hot-wallet generation, requested resource set, selected inputs/nonce, fees, transaction ID, and generation.

Suggested sweep-operation states:

`eligible -> waiting_funds|waiting_gas|deferred_dust -> queued -> executing -> settled`

Signing, submission, confirmation, and definitive failure belong to the independently identified execution attempt, not the logical sweep operation. Use `attention` for an ambiguous or exhausted attempt, `failed` only for a definitive failure, and explicit cancellation/supersession transitions. Record the reason for deferred work and its next evaluation time.

### Execution rules

- Reserve the source execution slot/resources in PostgreSQL before preparing or signing. Duplicate triggers attach to existing work rather than create another spend.
- Re-read canonical spendable resources immediately before preparation. Deposit journal totals are not a transaction input selector.
- Coalesce several finalized deposits to reduce fees. An arrival during an in-flight sweep becomes the next generation and cannot alter already signed bytes.
- Emit `transaction.prepare`; after `transaction.signed`, persist and automatically enqueue `broadcast.requested` through the Wallet outbox.
- Use the existing immutable signed-byte retry path. Finality updates custody and the sweep projection idempotently.
- Rescan after confirmation to find remaining native/token balances or UTXOs. A permanent periodic repair scan handles missed notifications and dust becoming economical later.
- Allow only the registered hot destination; the orchestrator and signer both enforce this. Management fee funding is a separate purpose, never a customer sweep destination.

### Chain adapters

| Asset family | Required implementation |
| --- | --- |
| EVM native | Add sweep-max preparation: reserve worst-case gas, estimate/cap fees, transfer the safe remainder, record actual cost, and evaluate leftover ETH/native dust afterward |
| ERC-20 | Add typed transfer preparation/signing; verify contract and decoded recipient; fund capped native gas from management account 1 where needed; sweep tokens before draining remaining native funds |
| Bitcoin/native UTXO chains | Discover address-owned UTXOs using a watch-only node/indexer; validate ownership, maturity and finality; reserve outpoints; create explicit sweep-all plans with hot-only asset outputs and no customer change; defer uneconomical inputs and split large sets without violating limits |
| Solana native | Estimate fees, prepare transfer-to-hot with explicit available balance, retain required reserves or validate full drain behavior; preserve expiry and prior-inclusion state |
| SPL tokens | Discover customer-owned token accounts; use typed transfers to hot-owned accounts for the same mint; support separate fee payer and multiple authorized signers; handle account creation/rent and account closure only under an explicit policy |

The existing Bitcoin signer sets the change address to its source; add a dedicated sweep plan rather than repurposing this behavior. Its current signing input is limited to one source key, so multi-customer Bitcoin sweep aggregation is a later adapter extension, not an assumed existing capability.

The existing Solana signer supports one key and native system transfers; sponsored SPL sweeps require an explicit signer/protobuf capability proof and independent signature verification. Do not assume fee sponsorship works merely because the chain supports it.

Fee-on-transfer, rebasing, frozen, delegated, or Token-2022 extension assets require separate certification. Credit/sweep accounting must use actual supported transfer semantics. Unexpected asset types remain observable and recoverable but are not auto-enabled.

## 8. Withdrawal workflow and hot-wallet scheduling

### Public API

- `POST /v1/customers/:customerId/deposit-addresses`: idempotent address assignment for an enabled chain/network.
- `GET /v1/customers/:customerId/balances`: pending, available, reserved, and frozen exchange balances.
- `GET /v1/customers/:customerId/deposits`: deposit status, credit identity, and history.
- `POST /v1/withdrawals`: customer ID, canonical asset/network, destination, amount, accepted fee quote, and `Idempotency-Key`.
- `GET /v1/withdrawals/:id`: logical payment status and permitted attempt details.
- Internal/admin endpoints: bootstrap, management funding, sweep retry, reconciliation, and incident resolution.

Initially reject destinations registered as exchange-owned hot, management, or customer deposit addresses. A future internal-transfer API can atomically debit the sender liability and credit the recipient without an on-chain withdrawal or another deposit credit. Revalidate ownership against the registry at execution and in signer policy to cover registry changes after request acceptance.

Use the authenticated exchange backend as the caller, with explicit customer ownership validation and no tenant context. Extend authorization before offering direct customer access. Do not expose internal management creation, generic signing, or private source controls through these endpoints.

Remove or restrict `POST /v1/wallets/:id/transactions` for customer deposit wallets. A customer withdrawal cannot use a deposit wallet as a liquidity fallback.

### Withdrawal persistence and state

Add `WithdrawalOperation` with customer/domain, asset/network, payout destination, principal, accepted fee quote, request digest/idempotency key, Ledger reservation ID, selected hot generation, status/reason and revision. Link its immutable `Transaction` attempts through a separate attempt ID and replacement lineage. Proposed states:

`requested -> reserving -> reserved -> queued_liquidity|queued_execution -> executing -> settled`

Signing, submission, confirmation, failure, and attention belong to the execution attempt; they do not replace the logical withdrawal state or create a new customer obligation.

Use `rejected` for definitive validation/reservation failure, `cancelled` only after safe release, and `attention` for uncertain execution. Include monotonic version checks so late events cannot resurrect cancelled or settled operations.

### Reservation and execution saga

1. Wallet stores the withdrawal intent and fee quote under a customer/operation-scoped idempotency key, then emits `withdrawal.reserve.requested`.
2. Ledger checks and reserves funds atomically; emits `withdrawal.reserved` or a definitive insufficient-funds rejection.
3. Wallet records the result and schedules the withdrawal against the configured hot wallet. Insufficient hot liquidity keeps the operation queued with an explicit reason.
4. The hot execution scheduler reserves resources, prepares, signs, and automatically broadcasts.
5. Broadcast confirmations drive idempotent settlement in Ledger. Distinguish logical operation ID, attempt ID, chain transaction identity, broadcast generation, and observation revision.
6. A safely cancelled unsubmitted withdrawal releases its reservation. Signed or possibly submitted attempts require reconciliation before cancellation/release.

### Safe concurrency first, throughput second

Keep `one_pending_per_wallet` initially. Persist many queued withdrawals as logical operations, but let the scheduler create only one active operational transaction for the hot wallet. Do not reject a customer merely because another withdrawal is executing.

After correctness is established, replace this restriction deliberately with:

- EVM nonce reservations per hot wallet/network and bounded in-flight nonce windows, plus native/token liquidity reservations.
- Bitcoin UTXO reservations and immutable batch-output-to-withdrawal mappings; change remains hot-owned.
- Solana source/token balance and fee reservations, account contention limits, and expiry handling.

Bitcoin and Solana withdrawal batching can reuse family-specific capabilities after allocation/fee attribution tests. EVM batching requires a separately approved batch contract/smart-account adapter; independent EOA transfers are the initial approach.

A replacement shares the existing logical operation and customer hold. Fee bumps and new blockhash attempts must not create another principal debit. Persist replacement lineage and prove that an older attempt cannot also pay before issuing a new spend.

## 9. Messaging and signer authorization

Continue the current NestJS BullMQ integration, authenticated envelopes, outbox/inbox pattern, and service-owned databases. Introduce versioned business contracts such as:

| Producer | Contract | Consumer |
| --- | --- | --- |
| Wallet | `customer-wallet.registry.requested.v1` with wallet/domain/chain/network and registry revision | ActivityListener and Ledger, as separate deliveries |
| ActivityListener / Ledger | `customer-wallet.registry.acknowledged.v1` with consumer, revision, status, and start/backfill cursor | Wallet readiness projection |
| ActivityListener | `deposit.observed.v1`, `deposit.finalized.v1`, `deposit.reverted.v1` with canonical transfer identity | Ledger |
| Ledger | `deposit.credited.v1`, `deposit.reversed.v1`, `deposit.deficit-recorded.v1` | Wallet projection, sweep scheduler, operations |
| Wallet | `withdrawal.reserve.requested.v1` | Ledger |
| Ledger | `withdrawal.reserved.v1`, `withdrawal.reserve.rejected.v1` | Wallet withdrawals |
| Wallet / execution scheduler | `sweep.execute.requested.v1`, `withdrawal.execute.requested.v1`, `funding.execute.requested.v1` | Authorized Wallet execution workers |
| Wallet / Signer / Broadcast | `execution.attempt.updated.v1` with the validated attempt transition; each carries operation and attempt identity | Owning Wallet operation projection and Ledger settlement boundary |
| Wallet | `settlement.requested.v1`, `reservation.release.requested.v1` | Ledger |
| Ledger | `settlement.committed.v1`, `reservation.released.v1`, `reservation.release.rejected.v1` | Wallet operation projection |
| Any authorized producer | `custody.incident.opened.v1`, `custody.incident.updated.v1`, `custody.incident.resolved.v1` | Durable operations projection |

### Business envelope and delivery invariants

The `MessageAuth` HMAC envelope's `version: 2` is transport framing, not a business schema version; it contains the current `resetEpoch`, and version-1 envelopes are rejected. Each business contract has a versioned `type` ending in `.v1` and `schemaVersion: 1`; incompatible payload changes publish a new `.v2` contract and schema version. Do not reinterpret old payloads in place.

External provider discovery payloads must carry their source `resetEpoch`. ActivityListener compares it to its configured epoch before validating/queueing or sealing the payload; a missing or mismatched value is durably quarantined. It must never stamp an untrusted old provider event with the current epoch. Epoch-specific Pub/Sub topics are defense in depth, not a replacement for this check.

Every event has a unique `eventId`, `occurredAt`, `domainId`, `correlationId`, `causationId`, and positive monotonic aggregate `revision`. Where relevant it also has `customerId`, canonical `chain`/`network`/`asset_id`, `operationId`, `attemptId`, immutable SHA-256 `requestDigest`, and policy version. Amounts and fees are unsigned integer base-unit strings; transfer events include transaction hash plus chain-specific transfer identity. `operationId` identifies one logical obligation; `attemptId` identifies one concrete on-chain execution. Retries of an event keep the same event ID and content; an operation retry that changes approved execution bytes creates a linked new attempt, not a new customer obligation.

Persist each state change and its outbox event atomically in the producer-owned database. Fan out to each consumer through its own outbox delivery, dedupe key, and queue job; BullMQ queues are competing-consumer queues, not broadcast topics. A consumer atomically commits its inbox dedupe record, local transition, and resulting outbox events before acknowledging. Deduplicate by consumer plus `eventId`, then enforce business uniqueness and aggregate revision in the database. Duplicate events are no-ops; stale revisions cannot regress state; unknown schemas are durably quarantined. Queue ordering, job retention, and HMAC validity alone are not financial idempotency.

Registry acknowledgment is per consumer and revision. Wallet exposes an address only after both ActivityListener and Ledger have acknowledged the matching revision and the listener's start/backfill cursor covers the initial gap. A failed, missing, or stale acknowledgment leaves the address blocked.

### Aggregate state machines

| Aggregate | Allowed forward transitions and terminal/exception states |
| --- | --- |
| Wallet registry | `requested -> installing -> acknowledged -> ready`; failed install, missing consumer acknowledgment, or a coverage gap becomes `blocked`; a new revision requires fresh acknowledgments. |
| Deposit | `observed -> finalized \| failed \| reverted \| attention`; canonical reconciliation may move a previously finalized deposit to `reverted`, which creates a compensating posting rather than deleting history. Ledger credit state is `uncredited -> credited -> reversed`; if already spent, record a linked deficit and freeze withdrawals instead of making available balance negative. |
| Withdrawal reservation | `requested -> reserved \| rejected`; `reserved -> consumed` on settlement or `reserved -> released` after proven nonpayment and a safe release. Unknown signed/submitted outcomes retain the hold; rejected release does not release funds. |
| Withdrawal operation | `requested -> reserving -> reserved -> queued_liquidity \| queued_execution -> executing -> settled`; definitive pre-execution validation may become `rejected`; safe pre-sign cancellation becomes `cancelled`; ambiguous execution becomes `attention`; post-settlement reorg becomes `reconciliation_required` and uses linked compensation. |
| Sweep operation | `eligible -> waiting_funds \| waiting_gas \| deferred_dust -> queued -> executing -> settled`; safe cancellation becomes `cancelled`; an in-flight newer generation is separate work; ambiguous outcomes become `attention`; canonical reorg enters reconciliation. |
| Execution attempt | `created -> preparing -> signing -> signed -> queued -> submitted -> confirmed`; `failed` is allowed only for definitive failure; an unresolved outcome becomes `attention`; an unsubmitted expired attempt may be abandoned. Replacement attempts link to the prior attempt and cannot begin until reconciliation prevents both from paying. |
| Custody incident | `open -> acknowledged -> investigating -> resolved`; reopening creates a new revision. Freeze/hold actions remain until explicit authorized resolution; closing an incident does not erase its audit trail. |

Settlement consumes a specific confirmed attempt and records actual fee, canonical transaction/transfer identity, operation revision, and policy version exactly once. A reservation release is a separate explicit result; it is never inferred from timeout, missing RPC data, a cancelled queue job, or exhausted retries. Signed or possibly submitted withdrawal attempts cannot be cancelled/released until reconciliation proves nonpayment. Reorg handling uses compensating settlement and incident events linked to the original operation, journal batch, and attempt; it never creates a second principal debit or silently reduces another customer's liability.

BullMQ uses competing consumers, so these contracts do not imply pub/sub fan-out. For events required by several applications, commit a separate outbox delivery with its own dedupe key/job ID to each consumer-owned queue. Registry delivery must reach both Ledger and ActivityListener and receive readiness acknowledgments before an address is exposed. Use the same explicit fan-out rule for future additional consumers.

Include domain, customer where applicable, canonical asset/network, operation/attempt IDs, immutable request digest, correlation/causation IDs, schema version, and source revision. Consumers re-read their durable state and use uniqueness/transition guards. Queue ordering, queue job IDs, and queue retention are not the financial source of truth.

Signer policy must validate:

- Customer deposit source: account >=10; purpose is sweep; resulting asset destination is the registered hot wallet.
- Hot source: account 0; purpose is an authorized withdrawal or permitted treasury operation.
- Management source: reserved index and configured purpose, destination and amount bounds.
- Asset adapter, network identity, fee caps, decoded outputs/instructions, source derivation, and authorization expiry/digest.

The existing shared queue HMAC proves envelope integrity, not independent withdrawal authorization. Use a trusted signer policy registry and scoped policy authorization; do not trust a caller-supplied `role: hot` or `purpose: sweep`. Wallet Core continues deriving the key in memory and returning only signed data. It does not own the financial ledger or resource reservations.

## 10. Delivery phases and exit criteria

### Phase 0 — Configuration and contracts

Record the exchange configuration, supported asset contract, financial policy, provider gaps, and operation/message contracts. Implement and verify the guarded reset tooling and stale-epoch rejection, but defer the actual database reset and hot/customer bootstrap until the Phase 1 schemas and allocator are ready. Customer liabilities start at zero after that coordinated reset; test balances are created only through explicit fixtures or deposit events.

Exit: configuration/provider decisions are recorded; dry-run/reset safety, queue-epoch rejection, and provider-source-epoch rejection pass. Allocation-at-10 and empty-ledger assertions are not Phase 0 gates.

### Phase 1 — Custody domains and reserved allocation

Implement role/domain schema, allocator starting at 10, idempotent hot bootstrap, management configuration, signer seed binding, trusted signer role policy, and durable registry/subscription readiness.

Exit: after schemas are deployed, the coordinated reset runs successfully; customer creation cannot allocate 0–9; hot0 derives deterministically; concurrent replicas cannot create two active hot wallets or overlapping customer accounts; the first customer account is 10.

### Phase 2 — Exchange Ledger and deposits

Implement customer liabilities, deposit identity, finality credit/reversal, reservations, Ledger outbox, normalized transfer classification, internal-funding exclusion, customer balance APIs, and clean-state test fixtures.

Exit: duplicate deliveries credit once; sweeps and funding do not change user balances; concurrent holds cannot overspend; reorgs produce balanced compensating entries.

### Phase 3 — Native sweeps and hot withdrawals

Implement durable operations/attempts, native family sweep adapters, Bitcoin UTXO discovery/reservations, automatic submission, hot scheduling, treasury reconciliation, and restricted public transaction routes. Deliver all three native families, with per-chain feature flags during rollout.

Exit: finalized deposits are swept, withdrawals use only hot0, deposits arriving mid-sweep are picked up afterward, and crashes/uncertain broadcasts cannot pay or debit twice.

### Phase 4 — Fungible tokens and fee management

Implement/certify ERC-20 and SPL adapters, management gas funding, Solana fee sponsorship and hot token accounts, token metadata policies, actual fee accounting, residual cleanup, and unsupported-asset exception handling.

Exit: enabled token deposits can be credited, swept, and withdrawn end to end. Native-only completion is not completion of the all-supported-assets requirement.

### Phase 5 — Scale and production rollout

Add certified withdrawal batching and higher concurrency only after durable resources are implemented. Complete backfill/reconciliation, operational controls and incident workflows; run a single-domain/chain canary before expanding.

Exit: balances reconcile, replay tests pass, reservations and attempts recover after process/Redis outages, and rollout/rollback preserves published addresses and journal history.

## 11. Verification and operational acceptance

Use real PostgreSQL and Redis with mocked deterministic RPC/provider responses for failure tests. Add regtest/local validator/testnet smoke runs for signed transaction semantics; never rely on address derivation tests alone to certify a chain adapter.

Required regression scenarios:

- Hot account 0; customer account 10 first on an empty deployment; accounts 1–9 inaccessible to customer creation; allocator exhaustion and concurrent bootstrap.
- Reset removes old records and async work; explicit hot/management creation leaves the first customer allocation at 10.
- Customer authorization, network/seed isolation, and address reuse across EVM chains with independent financial scopes.
- Provider replay, alias/case changes, several outputs/logs, customer registry lag, resubscription/backfill, and out-of-order finality.
- External deposit credited once; sweep receipt at hot creates no new customer credit; management funding creates no deposit credit.
- Deposit reorg before/after sweeping and after withdrawal, with explicit deficit handling.
- Confirmed sweep/withdrawal reorgs, obligation restoration, and delayed confirmation of old/replacement attempts without another payout or unsafe hold release.
- Native sweep-max fees, tiny/dust deposits, fee increases, concurrent arrivals, spent/immature UTXOs, hot-only sweep outputs, and failed execution.
- ERC-20 gas funding, decoded recipient enforcement, token-first/native-last ordering, and unsupported token behaviors.
- SPL account ownership, hot destination account creation, rent/closure policy, multiple signatures, blockhash expiry, and inclusion recovery across RPC outages.
- Simultaneous withdrawals, idempotency conflicts, insufficient balance/liquidity, automatic submission, batch attribution and duplicate settlement events.
- Withdrawal to a customer/self/hot/management address is rejected; registry changes between request and execution cannot bypass the policy.
- Crash between Ledger reservation and event delivery; orphan reservation repair; timeout/cancellation concurrent with signing/broadcast.
- RPC acceptance followed by lost response; stale attempts/generations; fee replacement and late confirmation of an earlier attempt.
- Unexpected customer-wallet outflow and unexpected hot-wallet transfer: durable alert/quarantine without hiding custody loss in customer balances.
- Repeated development reset/bootstrap, empty initial customer balances, and rejection of stale jobs from a previous reset.

Track deposit credit latency, unswept value/age, gas-funding backlog, dust value, hot available/reserved liquidity, queued withdrawal age, stuck nonces/UTXOs, outstanding holds, reorg exposure, registry/backfill lag, and unexplained custody differences. Reconcile each asset/network: verified custody against customer liabilities plus explicit equity, fees, deficits, and in-transit/reconciliation accounts.

Roll out from the clean development state with separate switches for new address issuance, customer credit, sweeps, and withdrawals. Bootstrap/verify management addresses, install fresh subscriptions, run dry-run scheduling, then enable a canary. Once exchange operations are enabled, ordinary retries, deployments, and recovery must preserve their transactions, reservations, and journal entries; the development reset is a setup procedure, not a financial recovery action.

## 12. Reference material

The recommendations above combine the current repository implementation with these primary protocol references:

- [Trust Wallet Core usage](https://developer.trustwallet.com/developer/wallet-core/integration-guide/wallet-core-usage): HD account derivation and signing; node communication remains the application's responsibility.
- [Ethereum gas and fees](https://ethereum.org/developers/docs/gas/): native gas costs and fee handling for EVM operations.
- [ERC-20 standard](https://eips.ethereum.org/EIPS/eip-20): token transfer semantics and events; the adapter must distinguish contract destination from asset recipient.
- [Bitcoin Core send-all reference](https://bitcoincore.org/en/doc/29.0.0/rpc/wallet/sendall/): sweep economics and input-selection considerations. Use this as protocol guidance; keep signing in this project's Signer rather than moving private keys into Bitcoin Core.
- [Bitcoin Core UTXO listing source](https://doxygen.bitcoincore.org/wallet_2rpc_2coins_8cpp_source.html): watch-only/UTXO discovery behavior to verify against the deployed node version.
- [Solana fee abstraction](https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction): separate fee payer and sender authorization requirements.
- [Solana token transfer reference](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/tokens/basics/transfer-tokens.mdx): token-account transfers and checked mint/precision handling.

Validate the exact installed Wallet Core protobuf/signing capabilities before implementing token and multisigner adapters. Protocol support does not establish support in the current signer implementation.

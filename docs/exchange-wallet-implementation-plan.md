# Exchange wallet infrastructure implementation plan

Updated: 5 October 2026

Status: design reference with implemented registration/scheduling foundations; execution and rollout gates remain tracked in the checklist.

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
2. **A hot wallet belongs to the exchange.** There is one owner per deployment and no tenancy. User service owns email/password registration/login and token issuance; its user UUID is Wallet's customer UUID and external ID. Email/password hashes remain exclusively in User's database. Retain a technical custody domain/generation for seed/network configuration, with a hot wallet per enabled chain/network.
3. **Network isolation must respect key identity.** The existing unique key `(seed_id, chain, account)` means one seed cannot create separate rows at account 0 for the same chain on multiple networks. Use a distinct custody seed/domain for those networks initially. Do not bypass the constraint and treat the same key as two unrelated wallets.
4. **Credit at deposit finality; sweep afterward.** Under `exchange-financial-v1`, a finalized deposit becomes available before its sweep finishes. A withdrawal may queue while a sweep supplies liquidity, but signing/submission waits until hot0 has atomically reserved payout principal in the withdrawal asset and worst-case native execution fee in the network's fee asset. Customer deposits, management balances, and in-transit custody are not hot liquidity. Production changes require a new reviewed policy version.
5. **All assets means all explicitly supported assets.** Native coins are the first delivery milestone, followed by allowlisted ERC-20 and SPL tokens. Unknown tokens, NFTs, unusual token extensions, and unsweepable dust enter a visible exception state. The project must not advertise support for an asset that it can record but cannot sweep and withdraw.
6. **Fees cannot be swept as assets.** Sweep the maximum economically transferable amount, retain only required fee/rent reserves where necessary, and rescan for residuals. Start with exchange-paid network costs and zero customer withdrawal fee in development, within the documented budgets. Persist the fee quote accepted by the customer even when it is zero.
7. **User and Sweep are separate applications.** The seven applications are User, Wallet, Sweep, Signer, Broadcast, ActivityListener, and Ledger; every stateful application owns its database. User owns identity/login/token issuance, Wallet owns JWT-authenticated customer APIs, custody, and withdrawal coordination, Sweep owns sweep/funding lifecycle, ActivityListener owns verified observations/audit, Ledger owns financial state, Signer owns keys, and Broadcast owns submission retries. Sweep starts from Ledger's committed credit events, not pending listener discovery. Its scheduling foundation is implemented; execution remains Phase 4.

## 2. Current implementation and required changes

| Current component                                         | Existing behavior                                                                                                           | Exchange change                                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/user/src/users` and `auth`                          | Email/password registration/login, bounded salted scrypt, identity-only outbox, and short-lived RS256 access tokens         | Extend later with refresh/session revocation/email verification/recovery; User owns the private token key and never forwards credentials to custody services |
| `apps/sweep/src/sweep`                                    | Durable registry/credited-deposit projection and coalesced work; execution blocked                                          | Add resource reads/reservations, policy, funding, attempts, signing/submission saga, settlement correlation, and repair in Phase 4                           |
| `apps/wallet/src/custody` and `customers`                 | Authoritative role/domain/network models, hot0/management1 bootstrap and queued customer issuance from account10            | Deploy via guarded reset; retain readiness gates and add authorized fund execution in Phase4/5                                                               |
| Wallet custody migration                                  | Baseline plus additive custody migration starts the noncycling customer allocator at10; explicit hot0/management1 bypass it | Apply during guarded development reset; historical migration SQL remains unchanged                                                                           |
| `packages/chain/src/coin-metadata.ts`                     | Uses Wallet Core metadata and substitutes the hardened account component                                                    | Keep derivation compatible; add fixtures for account 0, reserved accounts, and account 10 on each enabled chain                                              |
| `apps/wallet/src/transactions/transactions.service.ts`    | Accepts a caller-selected wallet and transfer parameters; permits one pending transaction per wallet                        | Replace the customer flow with logical withdrawals; schedule operational transactions from the hot wallet or an approved sweep source                        |
| `apps/wallet/src/messaging/wallet-workflow.service.ts`    | Prepares transactions and records signer results; broadcast is requested separately                                         | Automatically enqueue broadcast for authorized sweep/withdrawal operations after signing                                                                     |
| `apps/signer/src/signing/signing.core.ts`                 | Derives keys and signs native transactions after validating address/path/network                                            | Enforce operation purpose, source role, and destination policy; add explicit token and sweep signing adapters                                                |
| `apps/broadcast/src/broadcast/broadcast.service.ts`       | Stores immutable signed snapshots; reconciles hashes, retries, and monitors confirmations                                   | Preserve this behavior; propagate operation/attempt identifiers and actual settled fee/result information                                                    |
| `apps/activity-listener/src/activity-workflow.service.ts` | Publishes transaction-level balance changes and tracks finality/reorgs                                                      | Classify individual deposit transfers, recognized sweeps, funding, and unexpected outflows against a trusted address registry                                |
| `apps/ledger/src/ledger.service.ts`                       | Journals address custody balances against clearing accounts                                                                 | Add customer liabilities, withdrawal reservations, deposit credit identity, internal custody transfers, and business events                                  |
| `apps/wallet/src/ledger/ledger-client.service.ts`         | Authenticated read-only Ledger balance queries; registration comes from queues                                              | Preserve HTTP reads only, with durable registration and reservation workflows over queues                                                                    |
| `packages/queue/src/messages.ts`                          | Authenticated BullMQ envelopes and action/result contracts                                                                  | Add versioned deposit/sweep/withdrawal contracts and durable consumer deduplication                                                                          |

Use the development reset workflow described in `README.md` to recreate all six owned databases (User, Wallet, Sweep, Broadcast, Ledger, ActivityListener) with the exchange schemas. Reset associated queues and provider state together so old work cannot run against new records. Existing development records do not require migration to a new owner. Additive tenant-removal migrations preserve immutable historical SQL and reject conflicting global identities rather than merging them.

## 3. Wallet roles, ownership, and derivation allocation

### Proposed Wallet database models

| Model                          | Essential fields and constraints                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CustodyDomain`                | Technical exchange custody generation, seed identifier, enabled chain/network configuration, operational status; private seed material remains outside PostgreSQL                                                                                                                                                |
| `Wallet` extensions            | `custody_domain_id`, `role`, optional `customer_id`, `active`, and configuration revision; roles: `hot`, `management`, `customer_deposit`                                                                                                                                                                        |
| `ManagementWalletPurpose`      | Reserved account, purpose, permitted actions, funding limits; internal administration only                                                                                                                                                                                                                       |
| `AddressSubscription`          | Wallet/address identity, chain/network, subscription status, start block/slot, backfill cursor, provider acknowledgment; SPL token-account addresses mapped to their customer owner                                                                                                                              |
| `AssetConfiguration`           | Versioned `(chain, network, asset_id)` identity, standard, decimals and display metadata, exact contract or token-program-plus-mint identity, certified lifecycle capabilities, finality/fee/threshold policy, and policy version. Symbols are display-only; decimals are verified against pinned configuration. |
| `Customer` or customer mapping | Stable UUID and globally unique `external_id` equal to User's UUID, provisioned through `user.registered.v1`; no tenant model                                                                                                                                                                                    |

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
2. Review and apply the guarded `npm run reset:development` script after the Phase 1 schemas are ready. It reads durable `.env` directly despite stale shell exports and acquires an exclusive `.env.reset.lock` bound to an owner token. Hold that lock through destructive work and final reset-marker clearing, which also verifies the durable epoch and marker. Services reject conflicting runtime epochs. The script recreates all six owned local databases, retires only the previous project BullMQ prefix and Pub/Sub subscription, and rotates the persistent epoch/topic/subscription names. Interrupted work resumes from the same durable epoch/namespaces; stale-lock recovery is explicit.
3. Update the external provider publisher to the new topic/epoch and require top-level `resetEpoch` on every discovery payload; the reset script cannot configure that separately deployed service. Install fresh watches and verify subscription acknowledgment/backfill before readiness.
4. Configure the development custody seed, networks, assets, and signer policy. A record reset does not clear blockchain state; use fresh local chain state or a fresh development seed when an empty on-chain starting point is required.
5. Bootstrap the hot wallet at account 0, then any explicitly configured management wallets in 1–9. Begin customer allocation at exactly 10.
6. Install/verify customer subscriptions, seed test fixtures deliberately, and start the exchange workers with the new epoch.

## 4. Service responsibilities and NestJS module layout

### Wallet application

Add these feature modules under `apps/wallet/src`:

- `custody/`: domain/role registry, hot-wallet bootstrap, management policy, registry events.
- `customers/`: customer mapping and deposit-address lookup.
- `deposits/`: deposit status projection and customer-facing deposit history.
- `withdrawals/`: customer intent, idempotency, reservation saga, execution queue, and settlement projection.
- `treasury/`: hot liquidity and custody administration. Sweep coordinates management fee funding; Ledger journals its custody/fee effect.

Reuse existing `transactions/` preparation and execution behind versioned queue commands. Sweep must not import Wallet application internals. One logical withdrawal or sweep may have several execution attempts; an attempt is not another customer payment.

**Phase 4 native implementation (11 October):** Wallet now owns an `execution/` module and authoritative source/resource fences; shared native adapters serve Wallet and Broadcast. The initial native sweep implementation conservatively permits one immutable attempt per operation. Safely unsigned retries use a linked superseding operation and residual sweeps use a new operation; signed/uncertain replacement is unavailable. Multi-attempt withdrawal replacement/hold handling remains Phase 5. Wallet owns native settlement/reversal revisions; Listener classifies and audits the matching persisted attempt. Independent Ed25519 spending authorization and Signer result attestation supplement queue HMAC. See [Phase 4 notes](exchange-wallet-phase4.md).

### User application

Own identity, email/password registration/login, password verification, token issuance, and its private Prisma database. Atomically publish `user.registered.v1` with only `userId`; Wallet owns financial identity provisioning and requests Ledger registration. User exposes no custody API or wallet provisioning state. Login issues short-lived RS256 tokens; Wallet verifies the public key locally and derives the customer from the subject. Keep the private token key exclusively in User, and separate it from the custody seed. Refresh/session revocation, email verification, password recovery, and MFA remain later work. See [authentication contract](user-authentication.md).

### Sweep application

Own registry/deposit projections, coalesced source/asset work, logical sweep/funding operations and attempts, policy/economics, scheduling/recovery, and settlement projection. Consume Ledger credit/reversal/deficit/incident results through independent outbox deliveries. Missing registries retain blocked work; reversal-first delivery and sticky review gates cannot authorize a sweep. Credited units are accounting hints, not on-chain balances. Phase 4 must reread resources and acquire authoritative execution reservations through the Wallet execution boundary before signing. Keep the current worker blocked until those safeguards are implemented.

### Ledger application

Add `accounts/`, `deposits/`, `reservations/`, and `settlements/` modules as the feature boundary grows. Ledger exclusively owns customer balances and atomic holds. Its transactional outbox and `OutboxRelay` persist independent Wallet/Sweep accounting and incident deliveries alongside journals. Durable settlement reversal fences retain uncertain holds even before execution intent arrives.

### ActivityListener application

The implemented application owns a durable PostgreSQL registry, watch/backfill generations, verified transfer classifier, and RPC/reorg recovery. It watches customer deposit addresses and reports both incoming transfers and unexpected outflows; it never schedules or executes sweeps. Retain this audit coverage so outflows/reorgs cannot bypass custody reconciliation. Missing registry or incomplete coverage pauses processing and retains replay.

### Signer and Broadcast

Keep the Signer outside financial database access. Give it a trusted policy configuration/authorization verifier. Keep Broadcast's database and responsibility unchanged in principle: persisted signed bytes, chain submission, retries, confirmation, and result events.

Only User and Wallet expose public application HTTP endpoints. Existing Wallet operational routes live under `/internal` with service credentials and must be excluded from public ingress. Signer, Broadcast, ActivityListener, and Sweep are queue/Pub/Sub application contexts with no HTTP server; Ledger provides authenticated private reads plus operator event/reconciliation compatibility routes. No application reads another application's database. Normal inter-service commands, registrations, and financial writes use HMAC-authenticated BullMQ and durable outbox/inbox delivery; Ledger operator compatibility HTTP actions remain private. Read-only balance queries use authenticated internal Ledger HTTP without registration side effects. The [development Compose overlay](../compose.apps.yaml) publishes only User/Wallet and scopes database credentials and key mounts to their owners.

## 5. Accounting model

Customer liabilities and physical custody must be separate account classes. Reusing the current wallet balance as a user balance would reduce the user balance whenever a sweep runs.

Use the P0-03 canonical `(chain, network, asset_id)` tuple and integer base-unit arithmetic. Asset identifiers are `token:<chain>:native`, `token:<evm-chain>:erc20:<lowercase-contract>`, or `token:solana:spl:<case-sensitive-token-program>:<case-sensitive-mint>`. Network identity remains an explicit tuple field. Native decimals are ETH 18, BTC 8, and SOL 9; token decimals are pinned per allowlist record and verified against the on-chain contract/mint. Symbols are never identity.

An asset can create customer credit only after its adapter certifies exact observation/finality, deposit credit, sweep, and withdrawal. Unsupported or ambiguous provider assets retain evidence in a custody exception; they are never auto-credited or swept. The current listener's free-form token identifiers are discovery input, not authorization. Initial token scope is conventional ERC-20 and classic SPL Token Program assets; fee-on-transfer/rebasing/frozen/delegated semantics and Token-2022 extensions require separate certification.

| Account group                                          | Normal side              | Purpose                                                      |
| ------------------------------------------------------ | ------------------------ | ------------------------------------------------------------ |
| Custody: customer deposit, hot, management, in transit | Debit                    | Where exchange-controlled assets physically reside           |
| Customer: pending, available, reserved, frozen         | Credit                   | Amounts owed to a customer and whether they can be withdrawn |
| Network-fee expense                                    | Debit                    | Fees borne by the exchange                                   |
| Withdrawal-fee revenue                                 | Credit                   | Customer fees explicitly agreed at request time              |
| Equity, deficit and reconciliation accounts            | Explicit by account type | Exchange funding and explainable differences                 |

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

1. Wallet derives a customer account >=10 and publishes `customer-wallet.registry.requested.v1` with customer identity, custody domain, chain/network, address, registry revision, and hot-wallet identity. This is not a customer-ready event.
2. The registry/subscription worker installs the provider subscription, records its acknowledgment, and establishes a backfill cursor. The provider is external to this repository, so subscription and payload changes are an implementation dependency.
3. Wallet marks the address ready only after both Ledger and ActivityListener acknowledge the matching registry revision and the provider reports complete initial backfill coverage.
4. ActivityListener receives a discovery event with top-level `resetEpoch` equal to the current `RESET_EPOCH`, verifies the configured network and chain data, and normalizes relevant transfers. Missing or stale epochs are quarantined before queueing, including events delivered to the current topic.
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

Sweep database: `SweepOperation`, `SweepAttempt`, optional `SweepDepositLink`, `GasFundingOperation`, and local scheduling/resource-claim saga state. Persist source wallet, asset, target hot-wallet generation, requested resource set, selected inputs/nonce, fees, transaction ID, and generation. Wallet's authoritative source execution fence must serialize every operational transaction using that wallet; Sweep requests it through the queue and cannot treat a local scheduling row as an execution reservation.

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

| Asset family               | Required implementation                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EVM native                 | Add sweep-max preparation: reserve worst-case gas, estimate/cap fees, transfer the safe remainder, record actual cost, and evaluate leftover ETH/native dust afterward                                                                                                                  |
| ERC-20                     | Add typed transfer preparation/signing; verify contract and decoded recipient; fund capped native gas from management account 1 where needed; sweep tokens before draining remaining native funds                                                                                       |
| Bitcoin/native UTXO chains | Discover address-owned UTXOs using a watch-only node/indexer; validate ownership, maturity and finality; reserve outpoints; create explicit sweep-all plans with hot-only asset outputs and no customer change; defer uneconomical inputs and split large sets without violating limits |
| Solana native              | Estimate fees, prepare transfer-to-hot with explicit available balance, retain required reserves or validate full drain behavior; preserve expiry and prior-inclusion state                                                                                                             |
| SPL tokens                 | Discover customer-owned token accounts; use typed transfers to hot-owned accounts for the same mint; support separate fee payer and multiple authorized signers; handle account creation/rent and account closure only under an explicit policy                                         |

The existing Bitcoin signer sets the change address to its source; add a dedicated sweep plan rather than repurposing this behavior. Its current signing input is limited to one source key, so multi-customer Bitcoin sweep aggregation is a later adapter extension, not an assumed existing capability.

The existing Solana signer supports one key and native system transfers; sponsored SPL sweeps require an explicit signer/protobuf capability proof and independent signature verification. Do not assume fee sponsorship works merely because the chain supports it.

Fee-on-transfer, rebasing, frozen, delegated, or Token-2022 extension assets require separate certification. Credit/sweep accounting must use actual supported transfer semantics. Unexpected asset types remain observable and recoverable but are not auto-enabled.

## 8. Withdrawal workflow and hot-wallet scheduling

### Public API

- `POST /v1/users/register` and `POST /v1/users/login` on User: identity registration and token issuance.
- `GET /v1/me` on Wallet: identity provisioning status.
- `POST /v1/me/deposit-addresses`: idempotent address assignment for an enabled chain/network.
- `GET /v1/me/balances`: pending, available, reserved, and frozen exchange balances.
- `GET /v1/me/deposits`: deposit status, credit identity, and history.
- Implemented Phase 5 `POST /v1/me/withdrawals`: native asset/network, destination, amount and body `idempotencyKey`; customer identity comes from the verified JWT. Wallet accepts/persists the pinned zero development fee and five-minute reservation quote.
- Implemented Phase 5 `GET /v1/me/withdrawals/:id`: owner-scoped logical payment status and permitted attempt details.
- Internal/admin paths under `/internal`: bootstrap, management funding, sweep retry, reconciliation, and incident resolution; use service credentials and prefer queued actions.

Initially reject destinations registered as exchange-owned hot, management, or customer deposit addresses. A future internal-transfer API can atomically debit the sender liability and credit the recipient without an on-chain withdrawal or another deposit credit. Revalidate ownership against the registry at execution and in signer policy to cover registry changes after request acceptance.

Wallet public routes require the User JWT, derive the customer UUID from its verified subject, and do not accept customer overrides. Internal backend callers use distinct service credentials on `/internal` routes. Do not expose internal management creation, generic signing, or source wallet/path/nonce/UTXO controls through customer APIs.

The compatibility transaction route moved to service-authenticated `POST /internal/wallets/:id/transactions`; Phase 1 now rejects authoritative custody wallets there; Phase 4 supplies operation/purpose authorization for trusted execution. A customer withdrawal cannot use a deposit wallet as a liquidity fallback.

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

Bitcoin and Solana withdrawal batching can reuse family-specific capabilities after allocation/fee attribution tests. EVM batch contracts/smart-account adapters are excluded by the 11 October transfer-only, EOA-recipient decision; EVM payouts use independent transfers. ERC-20 transfers necessarily invoke the token contract with fixed `transfer` calldata, but their payout recipients must have no contract/delegated code. No approval or arbitrary-call interface is permitted. SPL recipients are on-curve ordinary System-owned wallets; derive their associated token accounts for the actual token instruction.

A replacement shares the existing logical operation and customer hold. Fee bumps and new blockhash attempts must not create another principal debit. Persist replacement lineage and prove that an older attempt cannot also pay before issuing a new spend.

## 9. Messaging and signer authorization

Continue the current NestJS BullMQ integration, authenticated envelopes, outbox/inbox pattern, and service-owned databases. Introduce versioned business contracts such as:

| Producer                              | Contract                                                                                                          | Consumer                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Wallet                                | `customer-wallet.registry.requested.v1` with wallet/domain/chain/network and registry revision                    | ActivityListener and Ledger, as separate deliveries                      |
| ActivityListener / Ledger             | `customer-wallet.registry.acknowledged.v1` with consumer, revision, status, and start/backfill cursor             | Wallet readiness projection                                              |
| ActivityListener                      | `deposit.observed.v1`, `deposit.finalized.v1`, `deposit.reverted.v1` with canonical transfer identity             | Ledger                                                                   |
| Ledger                                | `deposit.credited.v1`, `deposit.reversed.v1`, `deposit.deficit-recorded.v1`                                       | Wallet projection, sweep scheduler, operations                           |
| Wallet                                | `withdrawal.reserve.requested.v1`                                                                                 | Ledger                                                                   |
| Ledger                                | `withdrawal.reserved.v1`, `withdrawal.reserve.rejected.v1`                                                        | Wallet withdrawals                                                       |
| Sweep / Wallet withdrawal coordinator | `sweep.execute.requested.v1`, `withdrawal.execute.requested.v1`, `funding.execute.requested.v1`                   | Authorized Wallet execution workers; ActivityListener purpose projection |
| Wallet / Signer / Broadcast           | `execution.attempt.updated.v1` with the validated attempt transition; each carries operation and attempt identity | Owning Wallet operation projection and Ledger settlement boundary        |
| Wallet                                | `settlement.requested.v1`, `reservation.release.requested.v1`                                                     | Ledger                                                                   |
| Ledger                                | `settlement.committed.v1`, `reservation.released.v1`, `reservation.release.rejected.v1`                           | Wallet operation projection                                              |
| Any authorized producer               | `custody.incident.opened.v1`, `custody.incident.updated.v1`, `custody.incident.resolved.v1`                       | Durable operations projection                                            |

### Business envelope and delivery invariants

The `MessageAuth` HMAC envelope's `version: 2` is transport framing, not a business schema version; it contains the current `resetEpoch`, and version-1 envelopes are rejected. Each business contract has a versioned `type` ending in `.v1` and `schemaVersion: 1`; incompatible payload changes publish a new `.v2` contract and schema version. Do not reinterpret old payloads in place.

External provider discovery payloads must carry their source `resetEpoch`. ActivityListener compares it to its configured epoch before validating/queueing or sealing the payload; a missing or mismatched value is durably quarantined. It must never stamp an untrusted old provider event with the current epoch. Epoch-specific Pub/Sub topics are defense in depth, not a replacement for this check.

Every event has a unique `eventId`, `occurredAt`, `domainId`, `correlationId`, `causationId`, and positive monotonic aggregate `revision`. Where relevant it also has `customerId`, canonical `chain`/`network`/`asset_id`, `operationId`, `attemptId`, immutable SHA-256 `requestDigest`, and policy version. Amounts and fees are unsigned integer base-unit strings; transfer events include transaction hash plus chain-specific transfer identity. `operationId` identifies one logical obligation; `attemptId` identifies one concrete on-chain execution. Retries of an event keep the same event ID and content; an operation retry that changes approved execution bytes creates a linked new attempt, not a new customer obligation.

Persist each state change and its outbox event atomically in the producer-owned database. Fan out to each consumer through its own outbox delivery, dedupe key, and queue job; BullMQ queues are competing-consumer queues, not broadcast topics. A consumer atomically commits its inbox dedupe record, local transition, and resulting outbox events before acknowledging. Deduplicate by consumer plus `eventId`, then enforce business uniqueness and aggregate revision in the database. Duplicate events are no-ops; stale revisions cannot regress state; unknown schemas are durably quarantined. Queue ordering, job retention, and HMAC validity alone are not financial idempotency.

Registry acknowledgment is per consumer and revision. Wallet exposes an address only after both ActivityListener and Ledger have acknowledged the matching revision and the listener's start/backfill cursor covers the initial gap. A failed, missing, or stale acknowledgment leaves the address blocked.

### Aggregate state machines

| Aggregate              | Allowed forward transitions and terminal/exception states                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wallet registry        | `requested -> installing -> acknowledged -> ready`; failed install, missing consumer acknowledgment, or a coverage gap becomes `blocked`; a new revision requires fresh acknowledgments.                                                                                                                                                                                                   |
| Deposit                | `observed -> finalized \| failed \| reverted \| attention`; canonical reconciliation may move a previously finalized deposit to `reverted`, which creates a compensating posting rather than deleting history. Ledger credit state is `uncredited -> credited -> reversed`; if already spent, record a linked deficit and freeze withdrawals instead of making available balance negative. |
| Withdrawal reservation | `requested -> reserved \| rejected`; `reserved -> consumed` on settlement or `reserved -> released` after proven nonpayment and a safe release. Unknown signed/submitted outcomes retain the hold; rejected release does not release funds.                                                                                                                                                |
| Withdrawal operation   | `requested -> reserving -> reserved -> queued_liquidity \| queued_execution -> executing -> settled`; definitive pre-execution validation may become `rejected`; safe pre-sign cancellation becomes `cancelled`; ambiguous execution becomes `attention`; post-settlement reorg becomes `reconciliation_required` and uses linked compensation.                                            |
| Sweep operation        | `eligible -> waiting_funds \| waiting_gas \| deferred_dust -> queued -> executing -> settled`; safe cancellation becomes `cancelled`; an in-flight newer generation is separate work; ambiguous outcomes become `attention`; canonical reorg enters reconciliation.                                                                                                                        |
| Execution attempt      | `created -> preparing -> signing -> signed -> queued -> submitted -> confirmed`; `failed` is allowed only for definitive failure; an unresolved outcome becomes `attention`; an unsubmitted expired attempt may be abandoned. Replacement attempts link to the prior attempt and cannot begin until reconciliation prevents both from paying.                                              |
| Custody incident       | `open -> acknowledged -> investigating -> resolved`; reopening creates a new revision. Freeze/hold actions remain until explicit authorized resolution; closing an incident does not erase its audit trail.                                                                                                                                                                                |

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

These phases use the same numbering and dependencies as the [TODO checklist](exchange-wallet-todo.md). Phases 0–8 deliver the initial exchange flow; Phase 9 is optional expansion. Preparatory work may proceed when its prerequisites are available, while each customer-facing capability remains gated on its verification.

### Phase 0 — Configuration and contracts

Record the exchange configuration, supported asset contract, financial policy, provider gaps, and operation/message contracts. Implement and verify the guarded reset tooling: direct durable `.env` validation, stale-runtime epoch rejection, persisted-plan recovery despite stale shell exports, exclusive lock ownership, interruption/resume fencing, and queue/provider-source epoch rejection. Defer the actual database reset and hot/customer bootstrap until the Phase 1 schemas and allocator are ready. Customer liabilities start at zero after that coordinated reset; test balances are created only through explicit fixtures or deposit events. The real isolated six-database failure/resume and two-round custody bootstrap rehearsal now passes; the actual deployment reset remains pending verified publisher/watch retirement and complete local configuration.

Exit: configuration/contracts and external dependencies are recorded; reset safety and stale-epoch rejection are verified. The coordinated reset procedure is ready to run once Phase 1 schemas are available. Allocation-at-10 and empty-ledger assertions are Phase 1 gates.

### Phase 1 — Custody roles, allocation, and bootstrap

Implement customer/domain/role schemas, reserved-index constraints, allocator starting at 10, idempotent hot bootstrap, management configuration, and seed/network-bound derivation. Implement Bitcoin regtest address/signing/RPC support before enabling that adapter. Persist readiness state, then run the coordinated reset and bootstrap after the schemas are deployed.

Local implementation and isolated acceptance are recorded in [Phase 1 notes](exchange-wallet-phase1.md). The deployment reset is still outstanding.

Exit: the coordinated deployment reset runs successfully; the first customer account is 10; hot0 derives deterministically; customer creation cannot allocate 0–9; concurrent replicas cannot create conflicting wallets. Address publication remains blocked until Phase 3 subscription/registry readiness is verified.

### Phase 2 — Durable messaging and exchange accounting

Implement shared business contracts, separate outbox deliveries and acknowledgments, Ledger account identities and journal batches, customer liabilities, deposit credit/reversal, withdrawal reservations, custody/fee settlement, and Ledger outbox/reconciliation. Preserve append-only balanced journals and database inbox/transition guards without cross-application database reads.

Exit: Ledger owns customer balances and holds durably; concurrent holds cannot overspend; duplicate/reordered events cannot credit or settle twice; custody-only movements leave customer liabilities unchanged; each financial transition is balanced and recoverable.

### Phase 3 — Deposit listener and customer deposit APIs

Implement registry projections and readiness acknowledgments, certified provider watch installation/removal and initial backfill, exact transfer identity and RPC finality verification, movement classification, incidents, and customer deposit/balance/history APIs. Select and certify the replacement Solana provider and deployed capabilities for each enabled network. Require top-level provider `resetEpoch` and keep unsupported assets in custody exceptions.

Exit: supported external deposits credit the correct customer once; registry/provider gaps are recoverable; internal funding and sweep receipts never create a second credit; only addresses with matching acknowledgments and complete initial coverage are exposed.

### Phase 4 — Safe execution and native sweeps

Implement durable sweep/funding operations and immutable execution attempts, source-resource reservations, trusted Signer authorization, automatic Broadcast submission, and native EVM/Bitcoin/Solana sweep adapters. Discover and reserve Bitcoin UTXOs; preserve source serialization, fee bounds, hot-only recipients, and ambiguous-attempt holds. Coalesce deposits and rescan residuals.

Exit: eligible finalized native deposits are swept to hot0; deposits arriving during a sweep create later work; fees and dust follow policy; crashes/retries/uncertain submission cannot create conflicting execution or duplicate custody settlement.

### Phase 5 — Hot-wallet withdrawals

Local implementation is documented in [Phase 5 notes](exchange-wallet-phase5.md). The initial native delivery uses one immutable attempt per logical hold, independently authorized hot0 signing, exact principal and same-byte retries. Automatic signed replacements/blockhash refresh remain unavailable; safely unsigned closure releases the original hold and a further payout needs a new customer request. This conservative restriction narrows replacement scope while preserving cancellation/reorg safety. Ledger execution intent is published atomically with spending authorization, after preparation and final authority/resource checks. Live deployment/provider/chain gates remain open.

Implement customer withdrawal requests and accepted fee quotes, authenticated ownership validation, Ledger reservation/result/release saga, hot liquidity scheduling, immutable attempts, automatic submission, settlement, and safe cancellation/reorg handling. Restrict generic customer-wallet transfers and reject exchange-owned destinations until a separate internal-transfer flow exists.

Exit: every withdrawal uses hot0, customer and hot resources are reserved separately, low-liquidity requests queue durably, and duplicate/late events cannot pay or debit twice or release uncertain obligations.

### Phase 6 — ERC-20, SPL, and fee management

Implement/certify ERC-20 and SPL adapters, management gas funding, Solana fee sponsorship and hot token accounts, token metadata policies, actual fee accounting, residual cleanup, and unsupported-asset exception handling.

Exit: enabled token deposits can be credited, swept, and withdrawn end to end. Native-only completion is not completion of the all-supported-assets requirement.

### Phase 7 — Operational recovery and controls

Implement periodic hot/management RPC and per-asset custody/liability reconciliation, idempotent repair workers, audited incident/freeze/retry controls, metrics, and recovery runbooks. Preserve operations, holds, and journals during recovery; the development reset is an initial setup action.

Exit: unexplained custody differences and stranded work are visible and recoverable without deleting financial history.

### Phase 8 — Acceptance and controlled rollout

Run real PostgreSQL/Redis integration tests with deterministic provider/RPC fixtures and signed-transaction smoke tests for every enabled adapter. Demonstrate deposit → credit → sweep → hot withdrawal and outage/reorg/ambiguous-submission recovery. Validate separate capability switches, dry-run scheduling, a single-domain/chain canary, and rollout/rollback procedures.

Exit: all required phase gates pass, enabled assets reconcile end to end, and rollout/recovery preserves addresses, operations, holds, and journals.

### Phase 9 — Optional follow-up backlog

After initial acceptance, add certified withdrawal batching/concurrency, bounded EVM nonce windows, multiple seed-isolated domains/rotation, an explicit internal-transfer API, or a separately owned Treasury service when justified. Each expansion needs its own resource, signing, accounting, and recovery verification.

These tasks are optional and do not block the initial serialized hot-wallet scheduler. Enable each only after its independent certification passes.

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

## Phase 6 implementation completion — 12 October

Transfer-only ERC-20/SPL custody is integrated across Wallet, Sweep, Signer, Broadcast, Listener and Ledger. Management1 funding/sponsorship, durable token/native resource claims, token-specific historical watches, owned-account residual repair, hot0 withdrawals against original holds, fee/rent accounting and canonical reversal are implemented. Deterministic PostgreSQL lifecycle tests supplement adapter/signature and recovery coverage. See [Phase 6 implementation and acceptance notes](exchange-wallet-phase6.md) and the completed P6 task checklist.

Live activation still requires the separate QuickNode gateway deployment/certification, actual asset certificates, native fee capital recorded in Ledger, application migrations and deployment canaries. No real token is enabled; all token feature flags default to false. General contract calls, approvals, token account closure and EVM batch contracts are excluded. Automatic treasury replenishment and signed replacements remain later work.

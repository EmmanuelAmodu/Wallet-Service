# Phase 3 — Deposit detection and customer APIs

Implementation date: 4 October 2026; direction updated 5 October 2026. QuickNode is the selected provider for Ethereum and Solana. Bitcoin regtest uses a separate Bitcoin Core gateway. User now owns identity/registration/login/token issuance, Wallet verifies customer JWTs, runtime tenancy is removed, and Sweep consumes committed accounting results; see [architecture](architecture.md).

Review follow-up, 5 October: different-block pending re-inclusion (R2) and mixed-network registry recovery fairness (R6) are fixed with regression coverage. The 231-test suite passes. P3-01/P3-06/P3-09 are complete locally; Phase 1 custody/bootstrap and P3-02 external provider acceptance remain pending. See the [review](exchange-wallet-phases1-3-review.md) and [checklist](exchange-wallet-todo.md).

## Implemented in this repository

| Area                   | Implementation                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry and coverage  | `apps/activity-listener/src/registry` and `provider` persist installation acknowledgments, provider generations, original start cursors, paginated historical coverage, and readiness revisions. Customer readiness requires registered hot0 and management1 on Ethereum/Solana. Custody wallets are projected without installing watches.                                              |
| Discovery verification | `packages/shared/src/exchange-discovery.ts` accepts lookup hints only. `packages/chain/src/exchange-verifier.ts` verifies the configured chain/network and reconstructs canonical transfers, amounts, fees, and finality through RPC.                                                                                                                                                   |
| Deposits               | ActivityListener persists exact transfer identities and publishes observed/finalized/reverted commands to Ledger and discovery history to Wallet through its outbox. Ledger owns spendable credit and compensation; Wallet history distinguishes chain observation from accounting status.                                                                                              |
| Custody classification | Owned funding, sweep receipts, change, and refunds cannot create customer liability. Expected sweeps require a persisted matching source, hot destination, native asset, amount, attempt/hash, and fee payer. A matched sweep above its fee cap freezes for policy review while settlement accounts for its actual cost once. Unknown customer outflows create custody-loss incidents.  |
| Incidents              | Ledger records custody losses against exchange reconciliation, freezes customer available liabilities, and retains reserved obligations. Known reorgs or later verified sweep purpose compensate loss postings; they never automatically unfreeze the customer. Unsupported assets remain visible custody exceptions without customer credit.                                           |
| Customer API           | `apps/wallet/src/customers` owns globally unique external customer IDs, durable Ledger identity registration/acknowledgment, idempotent deposit-address assignment requests, Ledger balance reads, and scoped deposit history. Public `/v1/me` uses User JWT identity; private `/internal/customers` administration uses a distinct service credential. No tenant identity is accepted. |
| Recovery               | Discovery receipts survive queue retention; per-transaction processing leases coalesce replicas. Periodic scans recover RPC gaps and missing jobs. Provider watch leases clean up interrupted/late installations. Rebuild/removal invalidates readiness until replay restores coverage.                                                                                                 |

Each Bitcoin output retains its `vout`, each ERC-20 log retains its log index, EVM internal native transfers retain trace paths, and Solana transfers retain outer/inner instruction positions. Native assets are the initial financial scope; token observations do not enable token custody. Solana parsed instruction/token-account verification prepares later token work but does not install SPL token-account watches or enable Phase 6.

An unavailable finalized head, missing transaction, or pruned history is uncertainty. It cannot reverse a credited deposit. A known canonical block mismatch or a complete verified replacement transaction can produce compensation. If a reorg changes a transfer's immutable value/counterparty, reverse the old credit and freeze for review instead of silently repricing the deposit.

Incomplete native attribution defers new final credit and net custody-loss postings while preserving prior credit. Proven customer participation in an incomplete outgoing transaction freezes the customer for review without guessing a net loss. Solana new native credit also requires a finalized System-owned destination. Later unavailable destination ownership cannot revoke prior credit; a known change to another program opens a custody-review freeze.

## Customer API

Public customer routes use `Authorization: Bearer <ACCESS_TOKEN>` from User's `POST /v1/users/login`. Wallet validates RS256 signature, issuer/audience, expiry/lifetime, UUID subject, and reset epoch locally using only User's public key. It derives the customer UUID from the verified subject and rejects caller-supplied identities. `EXCHANGE_DOMAIN_ID` binds the deployment. Registration originates at User's `POST /v1/users/register` and provisions Wallet/Ledger asynchronously; User has no custody endpoint or provisioning response fields. See [authentication setup](user-authentication.md).

| Method and route                             | Behavior                                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`                                 | Read the token owner's customer state; return 202 `awaiting_customer_registration` if provisioning is pending.                                                                                                |
| `POST /v1/me/deposit-addresses`              | `{ "chain": "ethereum", "network": "11155111" }`: create/return an owner-scoped assignment for configured Ethereum/Solana networks only.                                                                      |
| `GET /v1/me/deposit-addresses/:assignmentId` | Poll assignment and bind a subsequently registered wallet. Return an address only after current custody/Ledger/listener coverage checks.                                                                      |
| `GET /v1/me/balances`                        | HTTP 202 with `state: "awaiting_ledger_registration"` until `customer.registry.acknowledged.v1`; then read Ledger's pending, available, reserved, and frozen customer liabilities through authenticated HTTP. |
| `GET /v1/me/deposits?limit=50&cursor=...`    | Read scoped history, discovery/accounting state, transfer identity, journal references, and deficits.                                                                                                         |

User registration works before any wallet allocation; its durable event provisions Wallet identity and Ledger registration together. Replaying it cannot clear a freeze. The former backend `POST /v1/customers` is removed to prevent racing User ownership. Phase 1 allocation is still absent. Assignment persists intent and returns `waiting`/`custody_bootstrap_required` until a trusted registered account >=10 belongs to the customer. Customer identity acknowledgment is required alongside wallet readiness; Ethereum/Solana also require management1's matching Ledger acknowledgment. Bitcoin does not allocate management1 initially.

Legacy administration moved to `/internal/customers/:customerId/...` with `EXCHANGE_API_KEY`; operational wallets/transactions moved under `/internal` with `WALLET_API_KEY`. Those routes must stay off public ingress and are excluded from public OpenAPI. Customer JWTs cannot authorize them. Only User/Wallet publish application HTTP; Ledger keeps authenticated private read-only HTTP, while action and registration flows use HMAC-authenticated queues.

The re-inclusion fix keeps finalized inclusion evidence separate from replacement observations. A known old-block orphan compensates accepted deposits/custody losses before a new pending inclusion; unavailable RPC/history retains evidence and credit for recovery. Incomplete pending transfers cannot erase a previously finalized credit. Certified-network filtering precedes both recovery and cleanup batch limits, preventing old disabled-network rows from monopolizing work; certificate removal/restoration is tested.

## QuickNode gateway contract

`EXCHANGE_PROVIDER_URL` points to the authenticated exchange discovery gateway in the separate provider repository. It is **not** QuickNode's Streams REST API URL. The gateway adapts QuickNode Streams/watch filters and durable webhook ingestion to the following versioned protocol. QuickNode documents stream [creation/management](https://www.quicknode.com/docs/streams/rest-api) and [historical backfilling](https://www.quicknode.com/docs/streams/backfilling); creating a stream does not establish that every historical discovery has reached durable storage.

Every request includes the identity below and an `Idempotency-Key` derived from its full action/payload. Every acknowledgment must echo the same identity. Requests use the gateway's separate bearer key; upstream QuickNode authentication remains in the gateway.

```json
{
  "protocolVersion": 1,
  "provider": "quicknode",
  "domainId": "exchange-development",
  "resetEpoch": "CURRENT_RESET_EPOCH",
  "walletId": "UUID",
  "registryRevision": 1,
  "generation": "UUID",
  "chain": "ethereum",
  "network": "11155111",
  "address": "0x...",
  "assetScope": "native"
}
```

| Endpoint                    | Additional request fields                | Additional response fields                                                   |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /v1/watches/install`  | Optional `fromCursor`                    | `status: "installed"`, `watchId`, `startCursor`                              |
| `POST /v1/watches/backfill` | `watchId`, `fromCursor`, `throughCursor` | Same range/watch, `cursor`, `complete`, `transactionHashes` (<=500 per page) |
| `POST /v1/watches/remove`   | `watchId`                                | `watchId`, `status: "removed"`                                               |

The install cursor is a bounded chain snapshot, not the address's first observed transaction. An initial installation without a supplied issuance cursor backfills from the explicit `origin` sentinel through that snapshot. The gateway must interpret `origin` as the beginning of the address's history and fail if it cannot cover that history; it must not substitute the current head and silently skip deposits. Rebuilds resume from durable covered cursors. Backfill advances only after the range's discoveries are durably retained and retrievable; a complete page ends exactly at `throughCursor`. Live coverage must overlap this boundary. Empty ranges still need an explicit coverage acknowledgment. Any future bounded issuance cursor must come from trusted bootstrap evidence.

The gateway must persist installation/removal intent by provider/domain/epoch/wallet/revision/generation before contacting QuickNode, recover a lost create response without duplicating watches, and remove the exact retired generation after races or crashes. The ActivityListener also persists watch leases before remote installation. After a lost installation acknowledgment it repeats the idempotent install request to recover the watch ID, then removes the exact retired generation.

Live Pub/Sub messages and backfill discoveries use this strict signal shape; amounts, transfers, assets, owners, or provider confirmation counts are not financial input:

```json
{
  "schemaVersion": 1,
  "resetEpoch": "CURRENT_RESET_EPOCH",
  "discoveryId": "stable-provider-delivery-id",
  "chain": "ethereum",
  "network": "11155111",
  "transactionHash": "0x...",
  "walletId": "UUID",
  "registryRevision": 1,
  "source": "live"
}
```

`walletId`/`registryRevision` are optional lookup hints; `source` is `live`, `backfill`, or `reconcile`. Stable provider identities must survive redelivery. Native internal Ethereum transactions require complete trace discovery and a certified `debug_traceTransaction`/`callTracer` RPC endpoint. Solana requires successful canonical finalized transaction/block history. The local Bitcoin gateway uses `provider: "bitcoin-core"`, `network: "regtest"` and the same coverage protocol.

## Configuration and rollout gates

Set `EXCHANGE_API_KEY` (distinct from queue, Ledger, and legacy keys) and `EXCHANGE_DOMAIN_ID` for Wallet. Set `EXCHANGE_PROVIDER_NAME=quicknode`, `EXCHANGE_PROVIDER_URL`, and `EXCHANGE_PROVIDER_API_KEY` for ActivityListener. Set `EXCHANGE_EVM_TRACE_MODE=callTracer` only after verifying the endpoint supports the required trace semantics. `EXCHANGE_PROVIDER_CERTIFICATIONS` defaults to `[]`, keeping all live address readiness disabled.

A verified native profile has this shape:

```json
[
  {
    "provider": "quicknode",
    "chain": "ethereum",
    "network": "11155111",
    "assetScope": "native",
    "watchInstall": true,
    "watchRemove": true,
    "backfill": true,
    "stableTransferIdentity": true,
    "rawUnits": true,
    "resetEpochDelivery": true,
    "nativeTraceCoverage": true
  }
]
```

Add a separately verified Solana profile using its exact configured genesis hash; the trace flag applies to Ethereum. Certificates are operator configuration backed by acceptance evidence, not tests of a deployed provider account. Supply a separate `EXCHANGE_BITCOIN_PROVIDER_URL`, `EXCHANGE_BITCOIN_PROVIDER_API_KEY`, and `EXCHANGE_BITCOIN_PROVIDER_CERTIFICATIONS` with `provider: "bitcoin-core"` for regtest. Bitcoin observation uses `EXCHANGE_BTC_RPC_URL/USER/PASSWORD`; this does not enable regtest signing/withdrawals or change the legacy mainnet configuration.

`EXCHANGE_DEPOSIT_POLL_MS` defaults to 30 seconds, reconciliation to five minutes (`EXCHANGE_DEPOSIT_RECONCILIATION_MS`), and durable recovery scans to ten seconds (`EXCHANGE_RECOVERY_INTERVAL_MS`). Activity processing uses a bounded two-minute lease; an expired worker's replacement fences its delayed response. Registry recovery is called by the same scan. Existing `ActivityRegistryService.rebuild(walletId)`, `remove(walletId)`, and `recover(walletId)` provide fenced lifecycle actions; a deployed privileged admin surface remains operational-control work.

Apply additive Wallet/ActivityListener migrations using application-owned database credentials. No application records were reset or deployment databases migrated during implementation.

New migrations are `20261004210000_exchange_customers` and `20261005000000_customer_ledger_registry` for Wallet, and `20261004200000_provider_registry`, `20261004210000_exchange_discovery`, `20261004220000_incident_revisions`, `20261004230000_provider_watch_cleanup`, and `20261004240000_discovery_leases` for ActivityListener. Existing migration histories are preserved. ActivityListener also adds `20261005180000_retained_finalized_inclusion`, retaining prior finalized block/height independently of current pending inclusion and backfilling accepted evidence from stored transfers. Ledger adds the separate Phase 2 `20261005150000_settlement_reversal_fence` migration.

Before enabling customer addresses, finish Phase 1 custody ownership/bootstrap, and implement/deploy the gateway contract in the external provider repository. Then verify QuickNode Sepolia/Devnet subscription installation/removal, initial and rebuild backfill including empty ranges, trace/instruction discovery, RPC identities, webhook/Pub/Sub current-epoch delivery, lost acknowledgment recovery, and known reorgs. Certify local Bitcoin regtest separately. Until those checks pass, **P3-02 and the overall Phase 3 rollout gate remain open**; the reviewed R2/R6 local defects are resolved.

Known fail-closed RPC limits: Solana parsed native amounts outside JavaScript's safe integer range need a lossless RPC adapter; failed inner CPI attribution is rejected as ambiguous. Generic programs and token lifecycle effects require complete native attribution before new financial postings. Recognized ComputeBudget/Memo programs do not invalidate native transfer completeness. Unavailable archival/canonical history retains prior credit and retries. Provider history retention, including Solana Devnet, must be verified before acknowledging origin coverage. Token-2022, unusual ERC-20 semantics, SPL subscription lifecycle, and token financial enablement remain Phase 6.

## Verification

Deterministic RPC and HTTP fixtures plus dedicated PostgreSQL/Redis integration tests cover multiple outputs/logs/instructions, exact base units, aliases, finality uncertainty, reorg compensation, live/backfill duplicates, registry lag/rebuilds, lost install acknowledgments, late watch cleanup, separate provider routing, unexpected outflows/refunds, delayed sweep purpose, authenticated customer ownership, and atomic projection/inbox commits.

Phase 3 baseline verification on 4 October: **190 tests passed**, with no failures or skips, against dedicated service PostgreSQL databases and Redis with deterministic RPC/provider fixtures. The latest 5 October fixes and User/Wallet authentication pass the expanded **231-test** suite, including retained inclusion, pending re-inclusion compensation/uncertainty, registry recovery fairness, and owner-scoped JWT access. Build, ESLint, Prettier, Compose configuration, and diff checks pass. No live QuickNode provider acceptance test or production migration was performed. The [TODO checklist](exchange-wallet-todo.md) records the current boundaries and retains execution/provider/bootstrap gates.

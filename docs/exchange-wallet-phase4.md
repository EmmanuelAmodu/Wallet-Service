# Phase 4 — Safe native sweep execution

Updated: 11 October 2026.

Phase 4 implements native sweeps for Sepolia, Bitcoin regtest and Solana Devnet. Runtime execution and broadcast remain disabled by default. This implementation does not establish deployment reset/bootstrap readiness or live provider/RPC certification.

## Ownership and queue flow

1. Ledger commits a finalized deposit credit and independently delivers the identical result to Wallet and Sweep.
2. Sweep coalesces source/asset work, checks its registry/review gates, and persists an operation, attempt and generation before publishing `sweep.plan.requested.v1` to Wallet.
3. Wallet acquires the authoritative source fence before querying canonical resources. It checks custody ownership, current policy, customer readiness, registry acknowledgments and native capability. Preparation records immutable amounts, fee bounds, expiry and nonce/outpoint/account claims. Wallet publishes `sweep.plan.prepared.v1` to Sweep.
4. Sweep rechecks its gates and accepts the exact prepared amount, rather than the credited planning hint. It delivers `sweep.execute.requested.v1` independently to Wallet, Ledger and ActivityListener.
5. Wallet revalidates the prepared chain resources and current authority. Policy rows remain locked through authorization/outbox commit. Wallet signs an Ed25519 spending authorization and publishes an attempt-bound Signer command.
6. Signer independently verifies authorization, domain/epoch, seed, both derivation paths, customer source account >=10, hot destination account 0, native asset, certified network, exact request digest, expiry, principal and fee/economics limits. Private wallet keys exist only during derivation/signing.
7. Signer returns signed bytes or rejection with a separate Ed25519 result attestation. Wallet verifies the whole result, persists the immutable signed result and atomically queues its bound Broadcast snapshot when authority remains ready.
8. Broadcast verifies that independent attestation, retains the immutable snapshot and retries the same bytes. Native outcomes use canonical adapter finality rather than the legacy confirmation shortcut.
9. Wallet independently observes the exact signed transaction and its canonical inclusion/actual fee. Ledger posts the custody movement and fee once; customer liabilities do not change. Wallet releases resources only after a matching Ledger acknowledgment and another canonical observation. Sweep requires both Ledger commitment and Wallet terminal proof for that same settlement revision.

All applications keep their own databases. There are no new public endpoints or cross-application database reads. ActivityListener continues to classify registered sweeps and audit customer outflows; it does not execute sweeps or independently journal their settlement. Wallet owns the settlement/reversal revision sequence.

## Native adapters

| Adapter | Preparation and signing | Confirmation |
| --- | --- | --- |
| Sepolia | Minimum of finalized/pending balances; matching latest/pending nonce; hot EOA; gas estimate with allowance; immutable worst-case fee reserve; hot-only remainder | Receipt and transaction match the decoded signed request/source; canonical block and finalized head; actual gas used × effective price |
| Bitcoin regtest | Address-filtered watch-only `listunspent`; `gettxout` ownership/value/unspent checks; 6 confirmations, 100 for coinbase; up to 100 inputs; durable outpoint claims; exact Wallet Core sweep-all fee plan; one hot output and no source change | Exact signed input/output set and txid; canonical block with 6 confirmations; actual selected-input total minus hot output |
| Solana Devnet | Ordinary empty System account; finalized balance; retained rent; exact compiled-message fee; original blockhash/height and validity recheck; one hot System transfer | Exact message and source signature; finalized transaction and canonical slot/block; actual metadata fee |

Adapters enforce `exchange-financial-v1` native minimums, fee/rent caps and the 1% economics rule. Preparation and immediate pre-authorization revalidation use canonical RPC data. Unsupported tokens and uneconomical balances remain visible deferred exceptions. Native sweeps do not require gas sponsorship; funding models are present but funding execution remains Phase 6.

## Fences and recovery

Wallet persists `CustodyExecution` and `ExecutionResourceClaim`. Its active-source partial index supplements `one_pending_per_wallet`: a confirmed transaction still retains its source fence until accounting acknowledgment and fresh canonical proof. SQL guards protect operation identity, preparation, authorization, signed result/bytes, monotonic revisions and resource retirement.

Sweep persists `SweepOperation`, `SweepAttempt`, funding/dependency models and exceptions. Each native operation has one immutable attempt. A safely unsigned retry creates a new operation with `supersedes_operation_id`; residual sweeps are separate operations. Automatic fee bumps, blockhash replacements and overlapping signed attempts are deliberately unavailable. Phase 5 implements hot withdrawal holds and recovery; automatic replacement remains deferred under P9-08.

A pre-creation deferral is a durable terminal planning decision: redelivering that attempt after recovery cannot reopen it. An unsigned prepared failure releases only under its source lock, before authorization, and sends matching preparation/terminal-safety proof. Sweep rejects missing, altered or post-signing deferral proof.

Authorization expiry or Signer rejection does not prove that an earlier delivery never signed. Authorized rejection, exhausted queues, lost RPC responses and expired signed Solana transactions therefore retain their fences. A delayed valid attested result can still reconcile that same attempt. A signed result received during a policy pause retains its attestation; after explicit authority recovery, repair can queue those same bytes if no broadcast delivery exists. It never creates replacement bytes.

RPC outages preserve accepted inclusion and claims. A proven orphan triggers a versioned Ledger reversal and pauses the custody domain for review. If a newer source attempt already exists, its fence remains intact. Re-inclusion is checked without repeatedly testing the already-orphaned block; it settles at a higher revision. Stale RPC snapshots, accounting results and terminal proofs cannot overwrite newer outcomes. Compensation changes custody/fees, not total customer liabilities, and review gates are not automatically cleared.

Wallet scans up to 40 due attempts in its current domain/epoch per interval. Sweep scans up to 100 eligible, deferred, residual or missed-trigger items with durable retry deadlines and fair scan ordering. Worker and relay restarts preserve state/outboxes. Exhausted transport jobs still require operator retry/review; this phase does not implement the complete Phase 7 recovery UI or automatically resolve uncertain signatures.

## Configuration and keys

`ENABLE_NATIVE_SWEEPS=false` and `ALLOW_BROADCAST=false` are the defaults. The asset's Wallet-owned `sweep_enabled` capability must also be enabled deliberately. Disabling the feature does not reopen HMAC-only legacy signing/broadcast routes in a custody deployment.

| Application | Key files |
| --- | --- |
| Wallet | `EXECUTION_AUTHORITY_PRIVATE_KEY_FILE`, `EXECUTION_SIGNER_PUBLIC_KEY_FILE` |
| Signer | `EXECUTION_AUTHORITY_PUBLIC_KEY_FILE`, `EXECUTION_SIGNER_PRIVATE_KEY_FILE` |
| Broadcast | `EXECUTION_SIGNER_PUBLIC_KEY_FILE` |
| User / Ledger / ActivityListener / Sweep | No execution-policy keys |

These are two separate Ed25519 pairs, independent of the custody seed and User's RSA token pair. Private keys require owner-only files; public-key inputs reject private PEMs. Fresh `setup:local` creates them. Existing environments can run `npm run setup:execution-policy`; the command refuses any existing key and does not rotate keys, alter `.env`, or enable execution. The Compose overlay mounts only each application's required files.

Timing settings: `EXECUTION_RECONCILIATION_MS`, `SWEEP_RECONCILIATION_MS`, `SWEEP_RETRY_DELAY_MS`, and existing Broadcast confirmation intervals. Keep the shared domain, reset epoch, seed/network identity and enablement settings consistent across workers.

Before enabling: apply owned migrations, complete P0-07/P1-07 deployment reset/bootstrap, certify the P3-02 gateway/watch/backfill protocol, verify live RPC identities/history, provision the correctly scoped keys, and run chain acceptance/canary checks. Bitcoin Core must have the relevant customer addresses in its watch-only wallet; the planner does not install provider watches.

## Verification

The 11 October whole-repository run passed all 325 tests with zero failures or skips. The automated suite uses dedicated PostgreSQL databases, Redis, deterministic RPC/provider fixtures and real Wallet Core signatures. Native smoke tests independently decode Ethereum/Bitcoin transactions and verify Bitcoin/Solana signatures. Integration regressions exercise source/resource fences, exact prepared amounts, independent attestation rejection, concurrent/replayed commands, unsigned failure, uncertain rejection, policy recovery, actual failed fees, settlement revision binding, stale observations, outages, reorg compensation and re-inclusion.

The complete application/tooling build, ESLint, formatting and diff checks passed. The Compose overlay passed configuration validation using temporary validation values for missing deployment settings; this confirms configuration syntax, not deployment readiness. Dedicated test databases were removed afterward. Application databases, `.env` and real key files were not modified. The legacy HTTP transport regression uses a test-only Signer factory; production Signer policy remains mandatory.

Live QuickNode gateway certification, RPC/testnet/regtest submission, deployment migration/startup and real fund movements have not been performed. These remain rollout/acceptance gates rather than implied by passing mocked-chain tests.

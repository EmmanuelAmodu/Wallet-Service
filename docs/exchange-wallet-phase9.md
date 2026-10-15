# Phase 9 — Scaling and optional custody extensions

Updated: 15 October 2026.

Status: throughput/recovery scope selected: P9-01, P9-02, P9-03 and P9-08. The first deliveries add immutable original-attempt history/private inspection and separate Ledger attempt authority bound to the original financial obligation. Actual replacement authorization, multi-attempt financial settlement, nonce windows and batches remain incomplete. Phase 8's outstanding live acceptance requirements remain in effect; new spending features stay disabled until independently certified.

## Current constraints verified in the code

- `CustodyExecution.operation_id` is unique: one logical operation currently has one execution and one immutable signed attempt.
- `one_active_custody_execution_per_source` allows one live execution per source wallet. `one_pending_per_wallet` also serializes pending transaction rows. Removing either constraint alone is insufficient to introduce safe concurrency.
- Withdrawal intents retain one unique reservation and one unique attempt. Authority checks require the plan's attempt, original hold, source, amount, destination and registry revision to match the stored intent.
- Native signing accepts exactly one payout output. Bitcoin/Solana batches need new explicit signing claims and independently verified per-member amounts; extending the generic output array would bypass the financial model.
- Ledger operations and reservation/settlement flows currently describe one logical obligation. Batch settlement cannot be treated as several unrelated copies of a whole-chain transaction fee or principal.
- Provider watches remain customer-only. Older funded generations must remain observable during any future rotation, even after new address issuance moves to another seed.
- Rollout policy, source fences, original holds, signed bytes and compensating journals remain authoritative. Phase 9 must not reintroduce tenants, arbitrary EVM calls, approvals, EVM batch contracts, or silent customer thawing.

## Selected scope

The user selected P9-01, P9-02, P9-03 and P9-08. P9-05 (multiple custody seeds/domains and rotation), P9-06 (internal customer transfers) and P9-07 (Treasury extraction) are deferred and are not part of this delivery.

P9-04 remains excluded by the approved transfer-only, EOA-recipient policy.

## Delivery order and completion gates

### 9A — Attempt lineage and replacement safety (P9-08 prerequisite)

Delivered original-attempt foundation:

- [x] Persist immutable original attempt identity, scope, source and obligation binding.
- [x] Capture preparation, authority, signer result, signed transaction, inclusion, settlement acknowledgment and reversal state atomically in an append-only journal.
- [x] Backfill existing execution state as a clearly labeled migration baseline, without inventing historical transitions.
- [x] Deduplicate unchanged evidence and roll back audit writes with a failed transaction.
- [x] Add privately authenticated, domain/epoch-scoped, bounded inspection with execution-scoped cursors.
- [ ] Complete the remaining multi-attempt/replacement work below before allowing any child attempt or relaxing source serialization.

- [x] Separate the accepted Ledger obligation and hold terms from immutable original-attempt authority. Replacement/child authority and multi-attempt settlement remain below as incomplete work.
- [x] Separate reported attempt revisions/content from canonical payment/reversal revisions; retain immutable report receipts and migration revision fences.
- [x] Retain immutable canonical settlement/reversal revision receipts, including durable historical payloads available at migration.
- [x] Add pure EVM/Bitcoin resource-conflict and complete-retained-lineage predicates; these do not grant replacement authority.
- [ ] Add explicit predecessor/attempt lineage, immutable original hold binding, principal/destination binding, preparation/signing evidence and chain-specific resource identity.
- [ ] Preserve existing operations, attempts, transaction hashes, holds and journals during schema migration; no development reset is a financial migration strategy.
- [ ] Reconcile every potentially payable attempt before authorizing another. An RPC error, absent recent signature, expired authorization or elapsed timer is not nonpayment proof.
- [ ] Define chain-specific replacement policies: EVM same-nonce fee bump, Bitcoin explicit conflicting-input replacement, and Solana fresh blockhash only after acceptable prior-attempt evidence.
- [ ] Bind approvals, fee bounds, predecessor evidence and new resources in authority signatures and signer attestations. Keep replacement transport messages separate from financial intent.
- [ ] Reconcile all historical attempt hashes, including delayed old-attempt confirmation and post-settlement reorgs; settle the original obligation exactly once and attribute actual canonical fees.
- [ ] Exercise crash boundaries, duplicate/reordered results, changed payload replay, unknown payment, stale epochs, cancellation races and reorg compensation in PostgreSQL/Redis fixtures.

Gate: a replacement cannot create a second customer obligation or payout, release an uncertain hold, hide old attempts or charge the whole fee more than once. No automatic replacement is enabled before this gate.

### 9B — Bounded EVM withdrawal windows (P9-01)

- [ ] Introduce explicit per-hot-wallet nonce allocations scoped to domain, epoch, seed, chain, network and attempt lineage.
- [x] Add atomic native fee/principal and per-token liquidity reservations for the existing one-attempt EVM hot withdrawal flow. Preserve uncertain/reverted exposure and protect immutable terms.
- [ ] Extend those reservations to independently authorized concurrent slots and replacement fee deltas; include every live/uncertain allocation in principal/gas availability.
- [ ] Extend preparation, revalidation, signing claims and broadcast checks to recognize only independently authorized reserved nonce slots.
- [ ] Account for tracked predecessors and unknown external nonce advances. A pending nonce returned by RPC is not evidence that a preceding customer withdrawal succeeded.
- [ ] Bound nonce distance, live attempts and fee exposure. Retain source serialization for sweeps, management funding, unsupported assets and uncertified paths.
- [ ] Replace existing unique source/transaction constraints only together with the corresponding application and database invariants.
- [ ] Test simultaneous customers, cross-asset gas competition, scarce native/token liquidity, failed predecessor, gaps, stale preparation, external transactions, old-attempt confirmation and reorgs.

Gate: concurrency above one stays disabled until resource isolation and replacement tests pass. EVM execution remains independent EOA transfers, with empty native calldata or certified fixed ERC-20 transfer calldata.

### 9C — Bitcoin withdrawal batches (P9-02)

- [ ] Persist an immutable batch and output-to-withdrawal mapping before signing: member withdrawal/hold IDs, exact destinations/principals, output indices and a deterministic fee allocation.
- [ ] Reserve mature hot-owned UTXOs, batch fee budget and hot-owned change under one batch attempt; do not weaken input ownership checks.
- [ ] Add batch-specific authority/signing/attestation contracts. Both Signer and Broadcast independently verify the full mapped output set and change.
- [ ] Settle or reverse each original obligation once from the canonical batch inclusion and deterministic actual-fee allocation; total member accounting must equal the chain transaction.
- [ ] Keep unknown submission and ambiguous members held. Define unsigned cancellation before batch membership becomes immutable; signed batches cannot be partially cancelled.
- [ ] Test equal recipients, multiple outputs to one address, duplicate membership, changed output ordering, dust change, fee rises, spent UTXOs, partial projection delivery, lost submission response and batch reorgs.

Gate: exact member attribution and aggregate custody/fee equations hold under replay and recovery. Multi-source/multi-key sweep aggregation is a separate certification, not an implied consequence of withdrawal batching.

### 9D — Solana batching and concurrency (P9-03)

- [ ] Persist immutable member and instruction mappings with original holds, account ownership, asset, payer, amount and ATA/rent attribution.
- [ ] Reserve source/token balances, payer lamports, rent and conflicting writable accounts; bound account contention, instruction count and serialized message size.
- [ ] Introduce explicit authorized native/classic SPL batch shapes. Retain on-curve ordinary System recipients, fixed transfer instructions and optional approved ATA creation only.
- [ ] Verify every compiled account, instruction, signer, amount and fee/rent bound independently in Signer and Broadcast.
- [ ] Preserve original attempts through blockhash expiry and RPC uncertainty; apply 9A's replacement/nonpayment rules before any refresh.
- [ ] Settle the atomic transaction with per-member principal/fee/rent attribution and exact compensation after reorgs.
- [ ] Test simulation failures, common fee payer contention, ATA creation races, writable account conflicts, oversize messages, expiry, uncertain inclusion and reordered results.

Gate: canonical signed Devnet/local-validator evidence passes for every enabled native/classic SPL shape. The Phase 8 Devnet faucet failure does not count as certification.

### 9E — Additional custody seeds/domains and rotation (P9-05, broader scope)

- [ ] Keep a single exchange owner; technical seed/domain isolation must not restore customer tenants.
- [ ] Define domain/epoch-aware address assignments, signer routes and queue authentication. Never route a private key derivation using an unverified caller-provided seed identifier.
- [ ] Add immutable rotation records and an explicit address-issuance generation selector. Do not mutate old address/path/seed bindings.
- [ ] Continue watches, backfill, canonical credit, sweep/reconciliation and recovery for older published funded addresses.
- [ ] Make old-to-new custody movement explicit with fee/capital accounting and generation-specific source fences.
- [ ] Test stale routing, cross-seed signing rejection, old-generation deposits during rotation and interrupted rotation recovery.

Gate: new issuance can move without abandoning funded old addresses or crossing signing/financial boundaries.

### 9F — Explicit internal customer transfers (P9-06, broader scope)

- [ ] Add an authenticated Wallet API with sender identity derived from the login token, recipient customer identity, canonical asset, exact amount and scoped idempotency.
- [ ] Use authenticated queue commands to Ledger; Ledger atomically debits sender available liability and credits recipient available liability, with deterministic account locks and journal/outbox publication.
- [ ] Require active owned customers and sufficient unreserved funds. Reject self-transfer, identity overrides, unsupported assets, changed idempotency and frozen accounts.
- [ ] Project statuses/history back to Wallet with repairable idempotent delivery. Internal transfers must never invoke Signer, Broadcast or provider deposit credit.
- [ ] Keep on-chain withdrawals to exchange-owned addresses rejected; the explicit transfer API is the only internal transfer path.
- [ ] Test competing internal transfers/withdrawals, reciprocity deadlocks, response loss, duplicates, freezes and unchanged total customer liability/custody.

Gate: exactly one atomic customer-to-customer liability movement; no on-chain movement or artificial deposit credit.

### 9G — Treasury application/database extraction (P9-07, broader scope)

- [ ] Confirm the operational need before introducing another service boundary; the original plan made extraction conditional on load.
- [ ] Document Treasury ownership for budgets, funding intents, approvals and repairs. Ledger retains financial journals; Wallet retains custody execution authority and customer withdrawal intent.
- [ ] Introduce the Nest application, separate Prisma database, authenticated queues and durable idempotent outbox/inbox contracts.
- [ ] Migrate existing management funding state without releasing uncertain exposure, recreating approvals or losing historical authority.
- [ ] Test lost commands/results, conflicting funding budgets, duplicate requests, pauses and restarts across the additional service boundary.

Gate: extraction preserves existing financial/signing invariants and has an operational justification beyond splitting code into another application.

## Certification and rollout

Each delivery needs focused regression tests, the complete acceptance suite, relevant real signed adapter smoke tests, documented schema compatibility and rollback, and a closed-by-default capability switch. Record source identity and chain/provider evidence independently. Do not mark P9 tasks complete for design work, fixtures alone when real-chain certification is required, or merely adding a disabled setting.

The existing Phase 8 acceptance runner and Phase 7 runbooks remain the baseline. This delivery adds Wallet history and Ledger attempt/progress migrations plus a read-only private endpoint; it does not activate financial replacement, batching or concurrency.

## Original-attempt implementation

Wallet migration `20261014010000_custody_attempt_history` adds `custody_attempts` and `custody_attempt_observations`. PostgreSQL captures execution/transaction transitions in the same transaction as their projection updates. Identity and journal rows reject updates/deletes. The existing active-source and pending-transaction constraints remain unchanged, and a database check rejects child attempts until explicit replacement authority is implemented.

Each observation carries a database SHA-256 digest of its canonical PostgreSQL JSONB representation. Unchanged observations are deduplicated. PostgreSQL canonical JSONB serialization differs from JavaScript JSON serialization; consumers must not assume `JSON.stringify` reproduces that digest. Journal sequences can have gaps and are returned as decimal strings.

The migration records current existing state with `migration_baseline` provenance; it does not reconstruct transitions that occurred before the journal existed. Later observations have `live_transition` provenance. Multiple captured statement transitions can belong to one committed transaction; an intermediate observation is not independent canonical payment evidence. These records aid review and future lineage work and do not replace cryptographic/chain verification or Ledger's financial authority.

`GET /internal/operations/executions/:transactionId/attempts?limit=50&cursor=<sequence>` uses Wallet's backend Bearer credential and distinct operations key. It exposes the immutable attempt identities and paginated evidence for the configured domain/epoch, including retained signed bytes. Customer tokens cannot access it. UUID paths, integer limits and signed-64-bit cursors are validated; cursors from another execution are rejected. This read-only route creates no spending authorization or financial adjustment and explicitly returns `replacementEnabled: false`.

Apply the Wallet migration through the normal release process. No application database migration/reset, new signing request, provider change or rollout activation was performed during local implementation. Preserve the journal and original execution rows on rollback; do not drop audit data to downgrade the application.

## Verified first-delivery acceptance

Stable-source run `019c2f9f4d7c4800911b539af678b6b7` passed **411 tests**, with zero failures, skips or cancellations. All application builds, TypeScript checks, lint and formatting passed. Source SHA-256: `aae4c9ed8c77da9be3315c1870d9a449a7b15d0fd2f9e910df4e6977a50e8f4c`. Completed `2026-10-14T20:46:50.498Z`; temporary acceptance databases were removed with zero cleanup failures.

Focused evidence covers migration of an existing execution without resetting financial state, immutable identity/history, unchanged-evidence deduplication, crash rollback, digest verification, refusal of child attempts, private-route authentication, bounded/scoped pagination, epoch/domain isolation, signed results, confirmed inclusion and canonical reversal history. Journal inspection creates no financial entries. Live adapter smoke was not repeated because this increment changes neither transaction construction nor chain submission semantics.

This certifies the original-attempt history increment only. P9-01, P9-02, P9-03 and P9-08 remain incomplete; the next required work is independently authorized child attempts with obligation-level payment reconciliation, followed by bounded EVM windows and explicit Bitcoin/Solana batch contracts.

## Ledger obligation/attempt separation

The next increment adds `LedgerExecutionAttempt` in Ledger's own database. `ExchangeOperation` and `WithdrawalReservation` remain the financial obligation and original customer hold; the new immutable row holds the exact independently bound execution intent. Settlement and reversal lookup now require that attempt to match the operation, domain, reset epoch, customer, request digest, operation kind and original reservation. The accepted per-attempt intent supplies execution authority; a mutable status projection does not grant it.

Ledger migration `20261014020000_immutable_execution_attempts` backfills existing accepted original attempts without changing operations, hold states, balances or journals. It checks the original hold's principal/asset, destination and hot-wallet identity. Legacy placeholder operations without an accepted attempt receive no invented authority. A mismatched existing accepted intent stops migration for review instead of manufacturing a new binding.

New database guards retain original operation identity and approval, immutable attempt authority, and accepted withdrawal terms (including amounts, original request and reservation journal). Financial status, settlement, freeze, compensation and reconciliation timestamps remain mutable through the existing sagas. Attempts cannot be reassigned to another obligation/hold, and an unapproved attempt cannot consume an existing hold. Child attempts remain rejected by database policy until their authorization and reconciliation protocol is implemented.

The Ledger migration must precede deployment of the updated Ledger worker. Old workers remain compatible with the retained original fields and the added root binding. Rollback retains the new tables/guards and all accepted requests, holds and journals; it does not delete attempt authority. No application database was migrated or reset during local verification.

This increment does **not** complete P9-08: independently approved child attempts, chain-specific replacement proofs, multi-attempt canonical winner/reversal state, signing authorization and winner reconciliation remain pending. P9-01–03 remain pending too.

### Verified Ledger separation checkpoint

Run `442cd673168547ffb153d14c6bf5154a` passed **413 tests** with zero failures, skips or cancellations. All application builds, TypeScript checks, lint and formatting passed; cleanup failures: zero. Finished `2026-10-14T20:55:40.335Z`. Tested-source SHA-256: `a203a386891298a38925bf90b9f8feb7e33ac526bac836b79f646f8432308ba0`. Local runtime evidence remains in `artifacts/acceptance/442cd673168547ffb153d14c6bf5154a/`.

Tests verify that an unapproved attempt cannot consume the original hold, accepted attempt/operation/hold terms cannot be mutated or deleted, child authority remains blocked, and the original payment can settle once, reverse, restore the same hold and settle again at the correct new revision without duplicate principal or fees. A staged migration test preserves an already accepted operation, its hold and all existing journals while backfilling the new immutable authority. Existing native/token custody and recovery tests remain regression gates.

## Independent attempt progress and report receipts

Ledger migration `20261014030000_attempt_progress` adds `ledger_attempt_progress` and immutable `ledger_attempt_reports`. Each accepted original attempt has independent reported state/revision/digest and canonical financial state/revision. Received report content is retained once per attempt/revision, including stale reports and late terminal observations. Digests use the existing canonical exchange-data serialization. Delivery identifiers may differ for identical report data; changed data at a received revision is rejected.

Previously, report replay compared against the obligation's current state. A duplicate submitted report could therefore conflict after canonical settlement changed that state to confirmed. Report replay now compares against its own receipt. A later report after settlement or reversal cannot overwrite canonical payment state, release the original hold or post financial journals. Reports, including reported confirmed/failed states, are not independently sufficient payment or nonpayment proof.

Migration preserves existing reported revision fences and canonical settlement/reversal projections without changing holds, balances or journals. It does not manufacture missing report bodies. If the historical reported state cannot be recovered separately from settlement, it is explicitly unknown. The first matching authenticated replay at that retained revision establishes its content receipt with `projection_replay` disposition; subsequent changed content is rejected. This receipt establishes what was replayed, not proof of the unrecorded original body.

A database trigger synchronizes retained operation fields into attempt progress for compatibility with older workers. It advances older-worker revision fences without inventing receipts and preserves a digest already recorded by the new worker. Canonical state follows accepted settlement/reversal updates independently. Existing deployment serialization still applies; this is not authorization to run concurrent attempts.

Apply the progress migration before deploying the new Ledger worker. Retain all attempt progress, report receipts, immutable authority, financial journals and original holds on rollback. The older application can still write its retained operation projection; it does not gain the new worker's replay semantics until upgraded. No application database migration or reset was performed during local implementation.

Regression coverage includes duplicate reports after payment, changed hash/terminal-safe fields at the same revision, conflicting stale reports, report delivery after reversal, canonical reinclusion, immutable receipts, monotonic progress guards, staged migration of active and already paid attempts, and legacy-worker projection updates. Child attempts, replacement authorization, winner reconciliation, nonce windows and batches remain incomplete and disabled.

### Verified progress/receipt checkpoint

Stable-source acceptance run `61153b1bb1fc4c6ba5630ea91d9926ac` passed **416 tests**, with zero failures, skips or cancellations. All application builds, TypeScript checks, lint and formatting passed. Tested-source SHA-256: `8230b482c670b081773082a517bec453d3754d21e89fe63b5d27771d4ac6ff28`. Finished `2026-10-14T21:07:47.758Z`; all disposable acceptance databases were removed with zero cleanup failures. Local evidence is retained in `artifacts/acceptance/61153b1bb1fc4c6ba5630ea91d9926ac/`.

This verifies the report/canonical-state separation prerequisite only. It does not certify replacement payments, larger nonce windows or batch signing. Real-chain smoke was not repeated because this increment changes neither transaction construction nor submission semantics. P9-01–03 and P9-08 remain open.

## 15 October — canonical history, custody liquidity and batch primitives

Ledger migration `20261015010000_canonical_attempt_receipts` retains immutable canonical settlement/reversal delivery bodies by `(attempt_id, revision)`, independently of later financial projections. A stale settlement replay cannot change its historical fee, outcome or hash after reversal/reinclusion. Duplicate data with a new delivery ID remains idempotent. Existing operation settlement payloads, reversal payloads and available `prior_settlement_payload` bodies are backfilled with explicit migration provenance. Missing delivery history is not invented. The migration changes no balances, holds or journals. Compatibility triggers also retain durable payloads written by older workers and bind reversals that arrived before their original execution intent.

Wallet migration `20261015020000_evm_liquidity_reservations` adds per-execution custody liquidity reservations. Native ETH and ERC-20 hot withdrawals reserve exact principal plus native gas under the existing source transaction lock, and signing requires that same immutable reserve. Canonical finalized and pending balances are checked conservatively; pending incoming liquidity cannot increase the finalized spend budget. Reservations preserve domain/epoch/seed/network/source/nonce/asset/request scope and record observation evidence. These custody resources are separate from original customer Ledger holds and create no liability journals.

Reservation terms cannot be edited or deleted. Unsigned terminal executions (including authenticated signer rejection) can release their custody reserve. Signed exposure stays retained until canonical terminal inclusion, Ledger acknowledgment and execution retirement. A reorg reopens the resource exposure and stops new allocation for review. Migration baselines preserve existing prepared exposure without claiming fresh chain observations. Apply the new Wallet migration before the updated Wallet application. Retain all resource records and audit tables on rollback. Application databases and rollout flags were unchanged during local implementation.

The shared EVM planning predicate can reason about windows bounded at 1–16 slots, shared native gas across assets, token balances, nonce gaps, uncertain exposure and untracked pending advances. **The live scheduler still uses one slot.** Existing source/pending-transaction constraints and original signing authority remain intact. This predicate is not evidence that an earlier nonce paid; admission above one still requires independently bound slots, actual retained-hash reconciliation and completion of replacement/winner gates.

Batch policy primitives define immutable member identity, canonical member order, separate original hold/attempt IDs, exact integer fee allocation and per-member rent/fee bounds. Repeated recipients remain separate obligations. EVM batch contracts remain prohibited. Bitcoin output mapping explicitly accounts for Wallet Core's change placement: payout 0, optional change 1, then remaining payouts. The exact-signing primitive verifies every output and owned change, exact inputs and actual fee rate, including repeated destinations. Existing custody signing policies still require one payout; these primitives do not admit a batch command.

Replacement predicates accept only unchanged native/ERC-20 EVM payment intent at the same nonce with bounded fee increases, or unchanged Bitcoin payout outputs using exactly the same owned input set and reduced hot change. Every retained predecessor must share the conflicting resource. The pinned 12.5 percent EVM bump is project policy, not a guarantee of provider acceptance. Bitcoin resource conflict is not relay admission: existing inputs do not opt in to BIP125, and any future replacement requires independently certified node/relay policy, incremental fees, fee-delta reservation and mempool testing. See [BIP125](https://bips.dev/125/) and [Wallet Core's Bitcoin output construction](https://github.com/trustwallet/wallet-core/blob/master/src/Bitcoin/TransactionBuilder.h); the installed Wallet Core output order is independently tested.

A fresh Solana blockhash is independently payable. The predicate explicitly refuses to treat expiry, elapsed time or an absent recent signature as resource conflict or nonpayment. Complete historical reconciliation remains required before refresh; see [Solana confirmation and expiration](https://solana.com/developers/cookbook/transactions/confirmation).

These are implementation components, not completion of P9-01–03/P9-08. Still outstanding: admitted child authority and retained-attempt reconciliation, canonical winner/fee arbitration, signed resource permits through Signer/Broadcast, activation of EVM windows above one, prepared batch chain-resource ownership and complete signing authority, Bitcoin/Solana batch dispatch and atomic member settlement/reorg handling, classic SPL batch compilation/certification, and end-to-end recovery/chain acceptance. No new spending capability has been enabled.

### Durable unsigned batch ownership

Wallet migration `20261015030000_withdrawal_batch_drafts` adds retained batch drafts and immutable member terms. `BatchDraftsService` is an internal Nest provider with no public/controller/queue admission route and no signer or broadcast publication. It can atomically claim fresh queued withdrawals whose original holds are already mirrored in Wallet, bind their exact customer/reservation/attempt/principal/destination/asset/hot-wallet identities, and retain the canonical manifest/cost-allocation digest. Frozen or unacknowledged customers, paused domains, unavailable hot registries, unsupported asset configuration, attempted withdrawals, cancellation and changed member terms prevent the claim. Token drafts require their exact transfer certificate.

Deferred database constraints require complete membership and exclusive ownership at commit; a crash or invalid later member rolls the entire claim back. A source fence prevents an individual transaction/execution from competing with a retained draft. The individual scheduler rechecks draft ownership under its existing source lock, and member cancellation requires prior dissolution of the whole unsigned draft. Terms and membership history cannot be edited/deleted, including after dissolution.

Unsigned dissolution atomically relinquishes every member and queues the original withdrawals again while retaining the same original customer hold IDs. It emits no financial release, signer or broadcast message. The schema supports only `planned` and `released`: a signed batch cannot accidentally use this unsigned-only release path. Claim/release are idempotent and source-serialized. Older workers are also fenced by database ownership checks. Existing rows are not reset; their new draft reference starts null.

This is draft membership/source ownership, not live batching. Prepared chain resources, actual output/instruction indices and authority, signed/broadcast batch attempts, original-obligation settlement and reorg compensation remain to be implemented. No production scheduler calls this planning provider and no batch spending flag is enabled. Apply all Wallet migrations before deploying the new Wallet worker; retain draft/membership history during rollback.

### Verified 15 October checkpoint before draft ownership

Run `929d425c2a1343f98a08adf4ede9e81b` passed **429 tests** with no failures, skips or cancellations, plus all builds, type checks, lint and formatting. Source SHA-256: `22ebef3c6f34cf9d025f601111802016b32fd017d82a2984c41272cc097bb572`. Finished `2026-10-15T09:44:58.828Z`; disposable database cleanup had zero failures. This evidence covers canonical receipts, EVM liquidity, Bitcoin exact output checks, batch planning/cost mappings and resource-conflict predicates. Draft ownership was added afterward and needs its own checkpoint below.


### Verified draft and nonce ownership checkpoint

Run `0213c491c75348b1834ae31ec5c59427` passed **433 tests**, all builds, type checks, lint and formatting, with zero failures, skips, cancellations or cleanup failures. Finished `2026-10-15T10:04:47.374Z`; tested-source SHA-256: `7e92b5d59ec5f6fc282d545de34fd70ec4657bd8f0aa2f8306a89b385f0d7084`. This checkpoint precedes the unsigned Bitcoin preparation changes below.

EVM nonce ownership now remains exclusive even after acknowledged settlement. A provider nonce rewind cannot assign the consumed nonce to another original obligation. Only a proved never-signed release relinquishes that nonce. Mixed-version preparation captures legacy workers' exact retained withdrawal exposure without inventing fresh RPC balance evidence. Unsigned draft dissolution has one narrow exception to original-attempt immutability: a completely dissolved draft-only attempt that never had an execution can be cleared while its immutable membership history and original hold remain retained.

### Unsigned Bitcoin preparation and reserved inputs

`BitcoinBatchPlanner` uses the existing native planner's independently checked mature owned UTXOs, pinned regtest identity and fee-rate bounds. It requires canonical P2WPKH source/recipients, preserves every original member as a separate output even for repeated recipients, keeps hot change at output 1, and binds exact inputs, principals, fee shares, change, expiry and resource keys in a preparation digest. Additional output bytes and a conservative signature-size margin are paid from hot change. Insufficient nondust change, a transaction fee over 10,000 satoshis or a member's exhausted fee budget defers preparation. The unsigned quote does not itself reserve inputs or grant spending authority.

Wallet migration `20261015040000_unsigned_batch_preparations` retains immutable preparations and complete exclusive batch UTXO claims. The private `BatchDraftsService.prepareBitcoin` rechecks domain/source/registry/asset/customer admission and commits preparation plus all claims under the source/resource locks. Database guards independently bind original payout mappings, deterministic fee allocation, exact input/principal/fee/change conservation and complete reservations. Cross-table resource fences protect both new batch workers and existing individual workers. An expired preparation cannot be silently replaced: dissolve the entire unsigned draft before replanning. Dissolution deactivates every resource claim but retains the preparation, mappings and resource history; no original customer hold is released. Apply the Wallet migration before deploying this provider and retain history on rollback.

The Bitcoin smoke now calls this same planner against disposable Bitcoin Core 29.0. It signs three exact payouts (including a repeated recipient), independently decodes every input/output and change, verifies actual fee and mempool admission, confirms six blocks, invalidates the inclusion block and confirms the **same transaction bytes/hash** on a new branch. Run at `2026-10-15T15:16:17.262Z` passed. Evidence is in `artifacts/acceptance/bitcoin-regtest/result.json`; it uses disposable fixture obligations and does not claim application batch authority, member financial settlement or public-network certification.

Still pending for P9-02: independent batch authority in Ledger/Signer/Broadcast, publication/dispatch, canonical per-original-hold member settlement, winning-attempt/reorg financial handling, cancellation after authorization and unknown-outcome recovery. There is no public batch endpoint, automatic producer or batch dispatch. P9-01, P9-03 and P9-08 also remain open.


### Verified unsigned preparation checkpoint

Run `9bd03a6c37ea41238419e33aae31ee2f` passed **437 tests**, zero failures/skips/cancellations, all application builds and type checks, lint and formatting. Finished `2026-10-15T15:22:45.566Z`; tested-source SHA-256: `8d62a348bb87986dcf8a51d4a17b6cd44657e8f2ec9236017ddbf3d7c49fd219`. Disposable database cleanup had zero failures. Evidence: `artifacts/acceptance/9bd03a6c37ea41238419e33aae31ee2f/result.json`.

New coverage includes actual signed batch input/principal/fee/change conservation and output ordering for repeated recipients; invalid recipients before RPC; spent/foreign inputs; insufficient change and fee budgets; incomplete preparation rollback; immutable mappings/resources; batch-versus-individual resource exclusion in both directions; idempotent preparation; and complete unsigned dissolution preserving original holds and history. The separate real Bitcoin Core regtest evidence above supplements this deterministic application suite. No application database or spending flag was changed.

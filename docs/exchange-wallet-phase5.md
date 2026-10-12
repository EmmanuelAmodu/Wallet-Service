# Phase 5 — Hot-wallet native withdrawals

Updated: 11 October 2026.

Wallet now owns customer withdrawal intents, a durable Ledger reservation saga and serialized hot0 execution for native ETH on Sepolia, BTC on regtest and SOL on Devnet. Execution remains disabled by default. Deployment reset/bootstrap, live gateway/RPC certification and chain submission acceptance remain required.

## Customer API

All routes require a User-issued access token. Ownership comes from its verified UUID subject, never from a supplied customer identity. Service credentials cannot authorize these routes.

| Route | Behavior |
| --- | --- |
| `POST /v1/me/withdrawals` | Persist an immutable intent and queue the customer hold; returns HTTP 201 and logical status |
| `GET /v1/me/withdrawals` | Owner-scoped list; optional UUID `cursor` and `limit` from 1–100 |
| `GET /v1/me/withdrawals/:id` | Owner-scoped status, destination, principal, accepted customer fee and transaction hash |
| `POST /v1/me/withdrawals/:id/cancel` | Empty JSON body; request safe unsigned cancellation and await Ledger release |

Request example:

```json
{
  "asset": {
    "chain": "ethereum",
    "network": "11155111",
    "assetId": "token:ethereum:native"
  },
  "destination": "0x1111111111111111111111111111111111111111",
  "amount": "10000000000000000",
  "idempotencyKey": "payout-2026-001"
}
```

Amounts are positive integer base units, never decimal coin values. The strict schema rejects caller-supplied source wallets, paths, fee settings, nonces, UTXOs and customer IDs. Idempotency keys are customer-scoped; identical canonical payloads return the original operation and conflicting payloads return HTTP 409, even after cancellation or settlement. Unknown or another customer's ID returns HTTP 404. Exchange-owned destinations, including legacy/inactive registered addresses, are rejected. Ethereum addresses are canonicalized to lowercase. Initial Bitcoin destinations are regtest P2WPKH with a conservative 546-satoshi dust floor; Solana recipient account/rent validity is verified during preparation.

The development customer fee is zero in the withdrawal asset. Wallet persists that accepted fee, policy version, request digest and the five-minute reservation quote expiry. Execution delay does not reprice an accepted hold. General nonzero/separate-asset fees remain supported by Ledger's existing contracts/tests but are not exposed by this API.

## Ownership and durable flow

1. Wallet validates customer/domain/epoch readiness, pinned native capability and registered hot0. The `Withdrawal` row, operation projection and `withdrawal.reserve.requested.v1` outbox commit together.
2. Ledger atomically checks available liability and creates one immutable logical hold, independently returning reserved or rejected status. Insufficient customer funds produce `rejected` with `insufficient_balance`.
3. Wallet schedules one active intent per hot wallet. A waiting intent owns the hot source fence before canonical preparation; later requests stay queued. This conservative ordering can cause head-of-line waiting when the first withdrawal cannot be funded. It never falls back to customer or management wallets.
4. Wallet persists immutable preparation and resource claims. Low hot liquidity keeps the customer hold and reports `waiting_liquidity`; RPC/policy dependencies retain planning work for recovery. Nonce/outpoint/account resources reserve principal and worst-case native fees separately from the Ledger customer hold.
5. The coordinator rechecks current customer/domain/asset/hot registry authority, external destination ownership and canonical resources. Address publication is fenced while authorizing. The Ledger/Activity execution intent and independently authorized Signer outbox commit atomically. Ledger execution intent is deliberately delayed until this point, so a safely unsigned cancellation can still release its hold.
6. Signer independently verifies the Wallet Ed25519 authorization, purpose `native_withdrawal`, hot role/account0/path, configured seed/network/epoch, hold identity, recipient, immutable request digest, expiry and principal/fee bounds. It returns an independently attested result. Wallet rechecks authority before queuing the immutable Broadcast snapshot.
7. Broadcast validates that attestation and retries the same bytes. Wallet observes canonical inclusion and actual fees; Ledger settles the original obligation once. Resource retirement and final customer status require matching Ledger commitment and a fresh canonical observation.

Withdrawal contracts and state live in Wallet's own database. Ledger owns holds/journals, Broadcast owns submission records, and Signer remains stateless with ephemeral derived wallet keys. There are no cross-service database queries or new worker HTTP endpoints. ActivityListener classifies registered purposes; Wallet is the authoritative native settlement/reversal coordinator.

## Native payment and recovery semantics

Ethereum pays the exact accepted amount and reserves worst-case gas. Bitcoin uses mature, owned watch-only UTXOs, a fixed Wallet Core plan and durable outpoint claims; independently checked change returns only to hot0. Solana pays the exact amount, retains hot rent and binds the original message/blockhash. Withdrawal minimums follow valid-transfer policy rather than sweep minimums/percentage economics; fixed native fee caps still apply.

Cancellation locks the same hot source and withdrawal row as authorization. It can retire planning/prepared work only when no spending authorization exists, then queues explicit Ledger release. A response of `cancelling` is not proof that the reservation has already been released. Cancellation requested before reservation acknowledgment waits for the original hold/rejection and does not lose it. Once authorization has been persisted, cancellation is rejected even if no signed result has arrived: an earlier queue delivery may already have signed.

Failed canonical execution releases the customer principal/development fee through settlement and journals any actual chain fee as exchange expense. Missing RPC data, Signer rejection after authorization, exhausted jobs and expired signed blockhashes retain the hold and source fence. No timeout is treated as nonpayment.

A proven outgoing reorg compensates the original settlement, restores the original customer obligation/hold and pauses custody for review. Stale events cannot resurrect settled/cancelled work. Canonical re-inclusion settles that same attempt at a higher revision. Wallet persists `terminal_proof_revision` and issues fresh proof even for an older retired execution when a newer hot fence exists; it never releases the newer attempt’s claims. There is no automatic new payout following an orphaned or unknown transaction.

Each logical withdrawal currently has one immutable execution attempt and one hold. Automatic fee bumps, transaction replacement and blockhash refresh are deliberately unavailable; this is a conservative deviation from the plan's broader replacement mechanism. Safely closed unsigned execution cancels/releases the original hold; another payout requires a new customer request/idempotency key. A future replacement feature must preserve the logical hold and first prove the prior attempt cannot pay. Batching/concurrent hot execution remains Phase 9.

Bounded fair repair scans replay missing reservation commands with the original quote, recover lost planning/preparation/terminal projection messages, and retry safe releases. Ledger publishes a fresh result delivery for a new reservation/release repair event without creating another hold or journal. Existing canonical execution scans preserve inclusion evidence, resume paused same-byte dispatch after authority recovery and reconcile reorgs. Exhausted Signer/Broadcast transport jobs and ambiguous signatures still require operator review/retry; the complete operational UI remains Phase 7.

## Enablement and verification

`ENABLE_NATIVE_WITHDRAWALS=false` is independent of `ENABLE_NATIVE_SWEEPS=false`. Wallet, Signer and Broadcast must share the withdrawal setting, domain and reset epoch; `ALLOW_BROADCAST=false` remains the separate submission gate. Wallet's asset `withdrawal_enabled` must also be deliberately enabled. Enabling either native feature loads the existing scoped Ed25519 keys; disabling one does not enable the other's commands or legacy signing. Sweep has no withdrawal key or withdrawal HTTP endpoint. Bitcoin Core's configured RPC wallet must import hot0 as watch-only for mature UTXO discovery, independently of deposit-only provider subscriptions; the planner does not install watches or import keys.

The build and targeted PostgreSQL/RPC/signature tests verify hot0 payments, exact native amounts and Bitcoin hot change, JWT ownership, strict input, idempotency, concurrent customer holds, low liquidity, cancellation races, frozen/changed destination authority, lost results, failed transaction fees, outgoing reorg restoration and same-attempt recovery. The final 11 October whole-repository run passed all 343 tests with no failures or skips using six dedicated PostgreSQL databases and Redis. Application/tooling build, ESLint, formatting, Compose configuration and diff checks passed. See the TODO checklist for local and live acceptance gates.

Live chain submission, external provider certification, application-image startup, deployment migrations and real fund movements have not been performed. Keep both native execution flags and broadcast disabled until the outstanding deployment and chain acceptance gates are complete.

## Recipient policy update — 11 October

Native Ethereum recipients now reject deployed/delegated code at finalized and pending RPC checks during planning/revalidation and immediately before dispatch. Reserved/precompile addresses are rejected. Native Solana recipients must be on-curve ordinary System accounts; dispatch rechecks program ownership. Phase 6 uses the same recipient-owner policy for token payouts. ERC-20 transfer calldata is generated internally; arbitrary contract calls and approvals are excluded.

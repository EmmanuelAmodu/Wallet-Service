# Exchange wallet initial implementation decisions

Date: 4 October 2026  
Scope: initial development implementation; application changes pending  
Related: [TODO checklist](exchange-wallet-todo.md), [implementation plan](exchange-wallet-implementation-plan.md)

Question 1 reflects the user's confirmed single-exchange requirement. Questions 2–7 record recommended implementation defaults so development can proceed. These settings belong in versioned configuration and tests; production gets a separately configured profile.

## 1. Custody and customer identity

Use one exchange per deployment. Remove the tenant model and `tenant_id`/`tenantId` from the exchange schemas, customer ownership, public/internal DTOs, queue contracts, authentication context, and tests as the new model is implemented.

- Customer identity: internal UUID plus globally unique `external_id` supplied by the exchange backend.
- Authenticate the exchange backend; its API credentials do not create separate tenants. Keep customer ownership validation and separate internal/admin permissions.
- Scope request idempotency by customer and operation type; include the immutable request digest.
- Retain a technical custody domain/generation for seed/network configuration and rotation. It does not represent a tenant.
- One configured development seed derives the hot, management, and customer keys across the three initial chains. Seed material stays outside service databases.

## 2. Initial networks and seeds

| Chain | Initial development network | Identity |
| --- | --- | --- |
| Ethereum | Sepolia | Chain ID `11155111` |
| Bitcoin | Local Bitcoin Core regtest | RPC network `regtest`; network-aware regtest addresses |
| Solana | Devnet | Genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, verified through RPC |

Use one network per chain per deployment. The same seed can derive different chains' hot0 wallets without changing the current `(seed_id, chain, account)` uniqueness rule. Do not add multiple networks of the same chain under that seed in this delivery. Development and production use separate seeds and configurations.

Bitcoin currently enforces mainnet configuration and Wallet Core's default coin/address metadata. Implement regtest-aware derivation/address encoding, validation, signing, and RPC identity checks before enabling Bitcoin development transfers. Changing only the RPC URL is insufficient. Keep the adapter disabled until its tests pass; the native milestone still includes Bitcoin.

Use deterministic local-chain/mocked-RPC fixtures for automated tests, with Sepolia/Devnet smoke runs. [Bitcoin regtest](https://developer.bitcoin.org/examples/testing.html#regtest-mode) allows controlled block creation and reorg scenarios.

## 3. Initial asset scope

Phases 1–5 deliver native ETH, BTC, and SOL. Phase 6 adds explicitly allowlisted ERC-20 and SPL tokens after each adapter passes deposit → credit → sweep → withdrawal certification.

Do not credit unsupported tokens as available customer balances merely because the existing provider reports them. Record unsupported assets as visible custody exceptions. Do not enable NFTs or unusual token semantics/extensions automatically.

## 4. Financial policy

### Finality and credit

| Chain | Spendable deposit credit and outgoing settlement policy |
| --- | --- |
| Ethereum/Sepolia | Successful receipt in a canonical block at or below the RPC `finalized` head; verify block identity. Replace the current 12-confirmation shortcut for this exchange flow. |
| Bitcoin/regtest | 6 canonical confirmations. Apply coinbase maturity checks in addition to confirmation policy before using inputs. |
| Solana/Devnet | Successful transaction at `finalized` commitment, with configured genesis identity. |

Ethereum exposes a [`finalized` block tag](https://ethereum.org/developers/docs/apis/json-rpc/#the-block-parameter); Solana defines [`finalized` commitment](https://solana.com/docs/rpc#configuring-state-commitment). Treat unavailable/stalled finality as pending, never as a reason to fall back silently to a weaker threshold. Tests may use explicit local overrides; defaults remain unchanged.

Credit every positive finalized transfer of an enabled asset: minimum credit is **1 base unit**. Credit exactly once by transfer identity. Tiny deposits retain their customer liability even when a sweep is deferred. Credit precedes sweeping; withdrawal execution also requires reserved hot liquidity.

### Native sweep economics

| Asset | Minimum net amount transferred to hot |
| --- | --- |
| ETH | `1000000000000000` wei = 0.001 ETH |
| BTC | `10000` satoshis = 0.0001 BTC |
| SOL | `1000000` lamports = 0.001 SOL |

For native sweeps, require the conservative capped network-fee estimate to be **at most 1% of the net sweep principal**. Enforce both the minimum above and actual chain validity/dust rules. Coalesce deposits first; otherwise record `deferred_dust` and retry when balance/fee conditions change. Do not round or discard the liability. Fee/rent reserves are separate from the amount transferred.

For enabled tokens, the initial minimum is 1 token base unit, subject to native fee/rent and management-funding budgets. Do not invent a fiat-value profitability rule without a defined price source.

### Development fee and rent caps

These are hard upper bounds, not fixed prices. Estimate from RPC, apply capped headroom, and defer/reject work that cannot execute within policy.

| Asset/network | Initial hard bounds |
| --- | --- |
| Sepolia ETH | `maxFeePerGas` <=100 gwei; priority fee <=2 gwei and <=max fee; maximum transaction fee budget 0.005 ETH (`5000000000000000` wei) |
| Regtest BTC | Explicit fallback 2 sat/vbyte when fee estimation lacks data; maximum 50 sat/vbyte and total fee 10,000 satoshis |
| Devnet SOL | Total transaction fee <=100,000 lamports; rent funding <=10,000,000 lamports per operation |

For EVM use the gas limit multiplied by the capped max fee as the reservation bound. For Bitcoin use a conservative signed-size bound and verify actual signed size/fee before broadcasting. For Solana include base and priority fees; query [rent requirements for the actual account size](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption), rather than hardcoding an account rent amount.

Actual sweep, gas-funding, rent, and withdrawal network costs are borne by the exchange. Keep customer credited amounts unchanged and fund the resulting expense/solvency requirement explicitly through exchange equity. Rent deposits remain custody where recoverable; they are not automatically fee expense. Unexpected costs above policy create an incident and are still journaled accurately.

### Withdrawal fee, cancellation, and reorgs

- Customer withdrawal fee: **zero in development**. Persist a versioned fee quote with amount zero, asset, request digest, and expiry anyway; test nonzero and separate-asset fees.
- Quote acceptance lifetime: **5 minutes**. Once accepted, the stored quote remains attached to the logical withdrawal; an execution delay does not silently reprice it. Updated terms require a new accepted request.
- Minimum withdrawal: positive integer base units and a chain-valid transfer/output. Bitcoin also enforces current output dust/relay rules. Reserve customer principal/customer fee and hot principal/native execution fee separately.
- Cancellation: permitted only before signing/submission, under an operation lock and durable cancellation fence. Signed or possibly submitted attempts keep their hold and source resources until reconciliation proves nonpayment.
- Definitively unpaid/failed withdrawal: release principal and the development customer fee; journal any paid chain fee as exchange expense. A timeout/missing RPC result is not definitive failure.
- Deposit reorg after spending: freeze the customer's withdrawals, compensate the deposit credit, and record the linked shortfall in an explicit deficit/recovery account. Keep available balance nonnegative; do not silently reduce another customer's liability. Domain-wide custody/finality compromise also pauses affected execution for reconciliation.
- Outgoing settlement reorg: compensate custody/settlement, retain or restore the same logical obligation/hold, and reconcile the old attempt before another payout. Never create a second principal debit or payout from a delayed confirmation.

## 5. External provider responsibilities

The separate [blockchain transaction listener](https://github.com/EmmanuelAmodu/blockchain-transaction-listener) was inspected at commit `5cec8b2679d0651f604a29dc1dcd9628d4a82cab` using authenticated read-only access.

Address filtering exists through QuickNode watched-address lists. The current repository does not demonstrate the full subscription lifecycle, acknowledgment, or cursor/backfill contract this exchange needs. Its transfer payload also loses individual output/log/instruction identity. Deployed provider-account capabilities still need verification.

Required work in that repository or an explicit provider adapter:

1. Idempotent address-watch installation/removal, readiness acknowledgment, configured chain/network, registry revision, start block/slot, and reset epoch.
2. Durable historical replay/backfill with an explicit cursor and live/backfill deduplication. Wallet must not publish an address as ready before the watch is acknowledged and the initial gap is covered.
3. Versioned discovery events with transaction/block identity, base-unit integer strings, and stable transfer identity: Bitcoin `vout`; EVM `logIndex` or trace path; Solana instruction/inner-instruction positions and token-account owner/mint/program.
4. Preserve original Bitcoin outputs and EVM logs/traces instead of grouped/index-free transfers; preserve raw SPL amounts rather than display-unit values.
5. Pub/Sub publishing in development and coordinated provider-watch reset. Current development publishing writes activities to local files.

Relevant source evidence: [transfer interface](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/types.ts#L33), [Bitcoin output grouping](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/bitcoin/quicknode-bitcoin.processor.ts#L158), [EVM trace processing](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/evm/quicknode-evm.processor.ts#L170), [Solana transfer processing](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/solana/helius-solana.processor.ts#L127), and [development publisher](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/apps/activity-listener/src/on-chain-activity.service.ts#L26).

Wallet infrastructure treats these messages as discovery signals and verifies exact transfers/finality through RPC or a trusted indexer. RPC reconstruction can supply exact transfer identity, but it does not replace watch readiness or historical coverage. Mock the new contract to develop in parallel; real-provider readiness remains a phase gate.

For private Bitcoin regtest, use a local watch-only node/indexer discovery/backfill adapter with the same readiness contract. Do not assume hosted QuickNode/Helius infrastructure can observe the private chain.

## 6. Management accounts

Account **1** is the gas/fee wallet on enabled chains where funding/sponsorship is required. Bitcoin account 1 stays unallocated initially because native BTC sweeps pay fees from their inputs. Accounts **2–9** remain reserved and unused.

- EVM funding: <=0.005 ETH per customer-wallet funding operation; <=0.01 ETH per customer wallet and <=0.05 ETH domain-wide per rolling 24 hours.
- Solana funding/sponsorship: <=0.01 SOL per operation; <=0.02 SOL per customer wallet and <=0.1 SOL domain-wide per rolling 24 hours. Sponsorship/account creation counts against these budgets even when no top-up transfer occurs.
- Count pending reserved spend plus settled spend against budgets; release only proven-unspent reservations. Reserve budgets atomically across workers. Funding transaction fees use the separate transaction fee caps and are included in total domain expenditure.
- Fund only the computed shortfall plus capped headroom. Reuse one funding operation for retries/dependencies; one outstanding funding operation per customer wallet and fee asset.
- Allow only registered same-domain deposit wallets and approved same-domain account creation/fee sponsorship. Enforce purpose, recipient, fee, and budget bounds in orchestration and trusted signer policy.
- Hot-to-management replenishment is a separate authorized treasury operation, not automatic replenishment that bypasses the limits above.

## 7. Ledger account representation

Add a small **metadata-only `LedgerAccount` chart of accounts**. Fields: immutable account ID/key, account type, normal side, owner kind/reference (`customer`, `wallet`, or `exchange`), canonical asset/network, and operational status. Enforce valid owner/type combinations and uniqueness in PostgreSQL.

`LedgerEntry.account_id` references that identity; the journal retains amount/side, sequence, `balance_after`, predecessor, reversal, and operation references. There is no mutable balance or next-sequence cursor on `LedgerAccount`. Latest append-only entries remain the balance truth; projections are rebuildable. Changing historical owner/asset/network/normal-side metadata requires a new account.

Add a journal transaction/batch identity for balanced atomic postings. Financial operations such as holds and releases must not require a fabricated on-chain activity. Existing on-chain activity becomes optional supporting evidence for the relevant batch.

This preserves the recent balance simplification while giving custody, liabilities, fees, and deficits enforceable account identities. Single-exchange ownership removes tenant fields.

## P0-07 — Complete the asynchronous-state reset

The reported PostgreSQL reset does not establish that the surrounding asynchronous state is clean. Implement and verify this coordinated development procedure:

1. Stop all application workers and the provider publisher; keep new address issuance disabled.
2. Create a new custody/reset epoch, persist it in each service's owned configuration, and require it in queue envelopes, provider discovery, registry revisions, and operation state. Keep it stable across normal restarts.
3. Use an epoch-specific project BullMQ prefix and registry namespace; remove/drain only the retired development namespace after workers stop. Do not flush shared Redis.
4. Create an epoch-specific development Pub/Sub topic/subscription and point both publisher and consumer at it. Retire the old development subscription/backlog deliberately; prevent old publishers from feeding the new epoch.
5. Remove old development provider watches/subscriptions, install the new registry, and acknowledge each start cursor. Rebuild through explicit backfill; fixtures must identify whether real pre-reset chain funds should be recognized.
6. Verify current schemas/empty initial customer liabilities, bootstrap hot0/management, and install ready customer watches. The existing database reset can be reused if schemas/state already match; schema work may require another coordinated reset.
7. Start workers with matching epoch/configuration, then exercise an old queue job, old provider event, and old signer/broadcast result. Consumers must reject/quarantine all of them before any financial mutation.

Every message consumer checks its expected epoch in addition to normal authentication, operation identity, and revision guards. Queue cleanup alone cannot guarantee that a delayed old result will never arrive. A record reset also does not clear chain balances; use fresh seed/local chain state or explicit fixtures as appropriate.

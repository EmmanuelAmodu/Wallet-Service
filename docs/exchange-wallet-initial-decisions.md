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

### Derivation account convention

`Wallet.account` is the hardened BIP-44/BIP-84 account component, not the final address index. Use account 0 for the domain's hot wallet per enabled chain/network; reserve 1–9 for management; allocate customer deposit wallets from 10 upward. The current one-network-per-chain and `(seed_id, chain, account)` uniqueness constraints remain in force.

| Chain family | Derivation path |
| --- | --- |
| EVM | `m/44'/60'/{account}'/0/0` |
| Bitcoin | `m/84'/0'/{account}'/0/0` |
| Solana | `m/44'/501'/{account}'` |

Account 1 is reserved for native gas/fee funding on EVM and Solana. It funds only approved same-domain customer-wallet fee shortfalls and account setup; it does not hold customer principal or serve as the hot withdrawal source. Bitcoin account 1 remains unallocated because Bitcoin transaction fees are paid from the transaction inputs. Accounts 2–9 remain unused until an explicit purpose and policy are approved. Management purpose enforcement and customer allocation boundaries are implemented with the P1 custody model, not by this decision record alone.

## 2. Initial networks and seeds

| Chain | Initial development network | Identity |
| --- | --- | --- |
| Ethereum | Sepolia | Chain ID `11155111` |
| Bitcoin | Local Bitcoin Core regtest | RPC network `regtest`; network-aware regtest addresses |
| Solana | Devnet | Genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, verified through RPC |

Use one network per chain per deployment. The same seed can derive different chains' hot0 wallets without changing the current `(seed_id, chain, account)` uniqueness rule. Do not add multiple networks of the same chain under that seed in this delivery. Development and production use separate seeds and configurations.

### Development profile recorded for P0-01

- Custody is single-exchange. The technical custody domain is a configuration/rotation boundary, not a tenant; its persisted identifier and generation belong to the P1-01 custody-domain model and are not yet runtime settings.
- The configured local seed identifier is `local-v1`; the seed material remains in the local secret file and is not copied into service databases or this document.
- Ethereum is configured for Sepolia (`11155111`). Solana is configured for Devnet (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`). RPC URLs are currently unset in the local environment, so no live provider identity check has been performed.
- Bitcoin's intended development network is regtest, but the current application default is mainnet and no Bitcoin RPC is configured. Do not enable Bitcoin transfers until P1-05 implements and tests regtest derivation, address handling, signing, and RPC identity verification.
- The chain RPC service checks the configured EVM chain ID, Bitcoin network name, or Solana genesis hash before chain observations and transaction preparation. Automated tests cover matching and mismatching identities; live smoke checks remain pending configured RPC endpoints.

Bitcoin currently enforces mainnet configuration and Wallet Core's default coin/address metadata. Implement regtest-aware derivation/address encoding, validation, signing, and RPC identity checks before enabling Bitcoin development transfers. Changing only the RPC URL is insufficient. Keep the adapter disabled until its tests pass; the native milestone still includes Bitcoin.

Use deterministic local-chain/mocked-RPC fixtures for automated tests, with Sepolia/Devnet smoke runs. [Bitcoin regtest](https://developer.bitcoin.org/examples/testing.html#regtest-mode) allows controlled block creation and reorg scenarios.

## 3. Initial asset scope

Phases 1–5 deliver native ETH, BTC, and SOL. Phase 6 adds explicitly allowlisted ERC-20 and SPL tokens after each adapter passes deposit → credit → sweep → withdrawal certification.

Do not credit unsupported tokens as available customer balances merely because the existing provider reports them. Record unsupported assets as visible custody exceptions. Do not enable NFTs or unusual token semantics/extensions automatically.

### Canonical asset identity and metadata

The canonical identity is the tuple `(chain, network, asset_id)`. `chain` is the canonical shared chain name (resolve aliases before persistence); `network` is the configured chain identity (EVM chain ID, Bitcoin RPC network, or Solana genesis hash). Display symbols and names are never identity.

| Standard | Canonical `asset_id` | Identity rules |
| --- | --- | --- |
| Native | `token:<chain>:native` | Exactly one native asset per canonical chain/network. |
| ERC-20 | `token:<evm-chain>:erc20:<contract>` | Contract is a 20-byte `0x` address, lowercased; chain and network are part of the tuple. |
| SPL | `token:solana:spl:<token-program>:<mint>` | Program ID and mint are exact case-sensitive Base58 identities; Solana network/genesis hash is part of the tuple. |

Each versioned allowlist record pins `chain`, `network`, `asset_id`, standard, decimals (integer 0–255), display symbol/name, contract or token-program-plus-mint identity, lifecycle capabilities, and policy version. Decimals are verified from the contract/mint against the pinned value; a mismatch or unrecognized identity is quarantined, not silently adopted. The key does not include decimals or display metadata. Existing provider token strings are discovery data only and must be resolved to an exact allowlist record before financial credit.

Native metadata is fixed for the initial profile: Sepolia ETH uses 18 decimals, Bitcoin uses 8 decimal places (satoshis; regtest adapter remains disabled until P1-05), and Devnet SOL uses 9 decimal places (lamports). Tokens have no defaults and must be explicitly configured per network.

An asset is financially enabled only when its adapter is certified for all four capabilities: exact transfer observation/finality, deposit credit, sweep, and withdrawal. Partial capability may be used for discovery/reconciliation only and cannot create an available customer balance. Native EVM/Solana signing and RPC primitives exist, but their exchange lifecycle remains subject to phase 3–5 certification; Bitcoin regtest is not enabled. ERC-20 and SPL adapters are not implemented and remain phase 6 work.

The initial ERC-20 allowlist accepts conventional exact-value transfer semantics only. Fee-on-transfer, rebasing, frozen/blocked, delegated, or otherwise nonstandard behavior requires separate explicit certification. Initial SPL support targets the classic SPL Token Program; Token-2022 and each extension require separate certification. ERC-721/1155, NFTs, unknown mints/contracts, and ambiguous legacy identifiers are unsupported.

Unsupported or malformed assets retain source transaction/transfer identity and raw provider evidence in a visible custody exception for review and reconciliation. They are not customer deposits, are not credited to customer available balances, and are not automatically swept or withdrawn. Listener observation is not an allowlist decision.

## 4. Financial policy

This section defines `exchange-financial-v1`, the normative initial development policy (effective 4 October 2026). Production requires a separately reviewed policy version. Persist the policy version with fee quotes and each authorized financial operation; a policy change creates a new version and never silently reprices or changes an accepted operation. Implementation phases must enforce these values rather than treating them as suggestions.

### Finality and credit

| Chain | Spendable deposit credit and outgoing settlement policy |
| --- | --- |
| Ethereum/Sepolia | Successful receipt in a canonical block at or below the RPC `finalized` head; verify block identity. Replace the current 12-confirmation shortcut for this exchange flow. |
| Bitcoin/regtest | 6 canonical confirmations. Apply coinbase maturity checks in addition to confirmation policy before using inputs. |
| Solana/Devnet | Successful transaction at `finalized` commitment, with configured genesis identity. |

Ethereum exposes a [`finalized` block tag](https://ethereum.org/developers/docs/apis/json-rpc/#the-block-parameter); Solana defines [`finalized` commitment](https://solana.com/docs/rpc#configuring-state-commitment). Treat unavailable/stalled finality as pending, never as a reason to fall back silently to a weaker threshold. Tests may use explicit local overrides; defaults remain unchanged.

Credit every positive finalized transfer of an enabled asset: minimum credit is **1 base unit**. Credit exactly once by transfer identity. Tiny deposits retain their customer liability even when a sweep is deferred. Credit precedes sweeping. A withdrawal may queue while liquidity is unavailable, but signing/submission cannot begin until hot0 has atomically reserved the payout principal in the withdrawal asset and the worst-case native execution fee in the network's fee asset. Customer deposit balances, management balances, and in-transit custody do not count as hot liquidity.

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

Helius is deprecated for this exchange and must not be used for development or production Solana discovery. No replacement vendor is selected. Implement against the provider-neutral discovery contract below, then select and certify a Solana RPC/indexer provider before enabling customer addresses or deposits.

### P0-06 capability findings

The listener is a webhook ingestion and activity-publishing service, not the exchange's address registry or historical indexer. QuickNode watched-address filtering is configured outside this repository. Its Pub/Sub subscriber acknowledges Pub/Sub messages; that is not an acknowledgment that a particular wallet address is watched or backfilled. The checked source does not implement idempotent per-address install/removal, registry revision acknowledgments, a per-address start cursor, historical chain replay, or live/backfill deduplication.

- **EVM:** webhook DTOs contain `logIndex` and trace DTOs contain `traceAddress`, but normalized `Transfer` contains only `from`, `to`, `amount`, and `token`. The processor drops log/trace identity, so ERC-20 deposits and internal native transfers cannot be credited independently and idempotently from its published event alone.
- **Bitcoin:** webhook inputs contain `vin`/`vout`, including output index `n`, but processing groups output values by address and emits transfers without `vout`. This merges distinct deposits to the same address. The listener handles webhook transactions; it does not expose spendable-UTXO discovery or a local Bitcoin Core regtest adapter.
- **Solana (deprecated prototype):** the former Helius adapter's input has mint, token-account/user-account fields, and raw token amount/decimals. Its normalized transfer omits token accounts, program identity, and instruction identity; its transfer amount is the display-unit `tokenAmount`, while balance changes use raw integer units. This is historical evidence only, not an approved provider choice; the replacement adapter must use raw base units and preserve the omitted identities.
- **Development delivery:** the listener writes activity JSON files under `NODE_ENV=development`; Pub/Sub publishing is used outside that branch. Local development therefore needs an explicit emulator-publishing mode and coordinated topic/subscription configuration.

These are source-level findings, not verification of the deployed QuickNode account's plan, watch limits, backfill availability, webhook configuration, or private-chain support, nor of any future Solana provider. A source-search cross-check against the current default branch on 4 October 2026 showed the same webhook/event shapes, but the search result did not provide a commit SHA; the pinned source links below remain the reproducible review basis. The Helius source references below are archival only. No provider credentials or deployed webhook configuration are present in this workspace, so account-level capabilities remain a pre-enable operational check.

Required work in that repository or an explicit provider adapter:

1. Idempotent address-watch install/removal, configured chain/network, registry revision, reset epoch, and per-consumer readiness acknowledgment. For SPL, map each subscribed token account to its verified owner, mint, and token program.
2. Durable historical replay/backfill with an explicit block/slot cursor, coverage acknowledgment, and live/backfill deduplication. Do not publish an address as ready until its initial gap is covered.
3. Versioned discovery events with transaction/block identity, base-unit integer strings, and stable transfer identity: Bitcoin `vout`; EVM `logIndex` or trace path; Solana instruction/inner-instruction position plus mint, token program, token accounts, and owner mapping.
4. Preserve original Bitcoin outputs and EVM logs/traces rather than grouping them by address; preserve raw SPL amounts rather than display-unit values. Validate decimals and identities against the configured asset allowlist.
5. Add a local watch-only Bitcoin Core regtest or equivalent indexer adapter for address history and UTXO discovery; hosted public-network webhooks do not observe the private regtest chain.
6. Add Pub/Sub emulator publishing in local development and coordinate topic/subscription/reset-epoch changes with P0-07.
7. Replace the deprecated Helius Solana prototype with a selected provider-neutral RPC/indexer adapter. Certify chain/network identity, subscription add/remove/acknowledgment, historical backfill, raw units, and stable transfer/token-account ownership identity before enabling Solana customer deposits.

Relevant source evidence: [transfer interface](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/types.ts#L33), [Bitcoin output grouping](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/bitcoin/quicknode-bitcoin.processor.ts#L158), [EVM trace processing](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/evm/quicknode-evm.processor.ts#L170), [deprecated Solana adapter (historical audit)](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/packages/on-chain-activity-processors/src/solana/helius-solana.processor.ts#L127), and [development publisher](https://github.com/EmmanuelAmodu/blockchain-transaction-listener/blob/5cec8b2679d0651f604a29dc1dcd9628d4a82cab/apps/activity-listener/src/on-chain-activity.service.ts#L26).

Wallet infrastructure treats these messages as discovery signals and verifies exact transfers/finality through RPC or a trusted indexer. RPC reconstruction can supply exact transfer identity, but it does not replace watch readiness or historical coverage. Mock the new contract to develop in parallel; real-provider readiness remains a phase gate.

For private Bitcoin regtest, use a local watch-only node/indexer discovery/backfill adapter with the same readiness contract. Do not assume hosted public-chain providers can observe the private chain.

## 6. Management accounts

Account **1** is the gas/fee wallet on enabled EVM and Solana chains where funding/sponsorship is required. Bitcoin account 1 stays unallocated initially because native BTC sweeps pay fees from their inputs. Accounts **2–9** remain reserved and unused. Apply the per-operation, per-wallet, and domain-wide rolling 24-hour caps below to both pending reserved and settled spend.

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

The reported PostgreSQL reset does not establish that the surrounding asynchronous state is clean. `npm run reset:development` is a dry-run-first local tool: it accepts only loopback PostgreSQL/Redis/Pub/Sub endpoints, resets the three service-owned databases to their Prisma baselines, obliterates only the retired project BullMQ prefix, creates a new Pub/Sub topic/subscription, retires the old subscription, and rotates `RESET_EPOCH` in `.env`. It does not flush Redis, remove provider watches, start/stop processes, or bootstrap wallets. Applying it requires explicit `--workers-stopped --publisher-stopped --provider-watches-removed` acknowledgments.

1. Stop all application workers and the provider publisher; disable address issuance. Remove old provider watches and record the provider's removal acknowledgment.
2. Run `npm run reset:development` once without arguments to review the local database targets and retired/new namespaces. Do not proceed if any database, Redis, or Pub/Sub endpoint is not loopback.
3. Apply with `npm run reset:development -- --apply --workers-stopped --publisher-stopped --provider-watches-removed`. Before any database/queue/Pub/Sub change, the tool atomically persists `RESET_IN_PROGRESS`, the new epoch, and the retired namespace identifiers in `.env`. Queue-backed services fail startup while that marker exists.
4. Configure the external provider publisher to use the printed epoch and new Pub/Sub topic. The tool cannot modify the separately deployed listener/provider. Install fresh watches, then verify per-address acknowledgment and backfill coverage before marking any address ready.
5. Run the normal setup/bootstrap steps: confirm baseline migrations, bootstrap hot0 and configured management wallets, and verify the first customer account is 10. The reset tool does not start services or bootstrap addresses.
6. Start provider publisher and workers with the new epoch/configuration. Replay an old queue envelope, old provider delivery, and old signer/broadcast result; the first and third must fail the epoch check, while the old Pub/Sub subscription is retired and the new topic must receive only current-epoch publisher traffic.

If the reset command fails after the marker is written, keep every worker and publisher stopped and rerun with `npm run reset:development -- --resume --apply --workers-stopped --publisher-stopped --provider-watches-removed`. Resume uses the persisted epoch, old queue prefix, and old subscription and safely repeats the baselines/cleanup. Never clear `RESET_IN_PROGRESS` manually; only the successful completion path removes the fence.

The authenticated queue envelope is now transport version 2 and includes `resetEpoch`; every consumer compares it to its configured epoch before any financial transition. Version-1 envelopes and mismatched epochs are unrecoverable. BullMQ prefixes include the epoch, so retired jobs cannot be selected by current workers. Service-owned databases are reset to remove old outbox/operation rows; later registry and operation models must persist the same epoch, and the external provider event contract must carry it or publish only to the epoch-specific topic. Queue cleanup alone cannot fence an already signed on-chain transaction. A record reset also does not clear chain balances; use fresh seed/local chain state or explicit fixtures as appropriate.

# Phase 6 — Transfer-only tokens and fee management

Updated: 12 October 2026. Local implementation is complete. Live token execution remains disabled until the provider gateway, asset certificates and funded custody accounts pass deployment acceptance. No real contract or mint has been configured.

## Supported operations

ERC-20 support is an internally generated `transfer(recipient, amount)` with zero native value. Callers cannot provide calldata, approvals, spender instructions, swaps, NFTs or general contract calls. The certified token contract is the transaction target; the recipient is a separately validated external wallet or the exchange's derived hot wallet.

ETH/ERC-20 recipients must have no deployed or delegated code at finalized and pending checks. Reserved/precompile addresses are rejected. Preparation, authorization revalidation and dispatch check this policy. These RPC checks cannot atomically prevent a recipient's subsequent state change.

Classic SPL recipients are on-curve, ordinary System-account owners, or absent accounts. Tokens go to the owner's derived associated token account, which necessarily belongs to the classic Token Program. Only `TransferChecked` and optional associated-account creation are signed. Token-2022, frozen/delegated accounts, wrapped native tokens, alternate close authorities and unsupported mint semantics remain exceptions. Token accounts are retained; account closure is prohibited.

## Completed lifecycle

| Task | Implementation and evidence |
| --- | --- |
| P6-01 | Actual installed Wallet Core 4.8.4 ERC-20 and one/two-signature SPL capability fixtures, with independent byte decoding and signature verification. |
| P6-02 | Certified ERC-20 planning, source nonce/token resource claims, independent authorization, private signing, attested broadcast and exact canonical transfer/fee settlement. |
| P6-03 | Management1 gas funding has a durable budget reservation and one funding identity per outstanding dependency. Listener and Ledger acknowledge its intent before broadcast. Dependent sweeps wait for canonical confirmation and Ledger settlement acknowledgment. |
| P6-04 | Token work and residual checks run before native drain. Wallet also checks canonical token balances/owned accounts before native signing. Source fences serialize assets; multiple SPL token accounts drain through successive settled operations. Native dust remains visible without repeated gas funding. |
| P6-05 | Binary mint/program/precision and owned-account checks, owner-address deposit attribution, independent token watch generations/backfill, non-ATA source discovery, derived hot ATA creation and rent accounting. |
| P6-06 | Management1 sponsors customer SPL sweeps with two signatures. Hot withdrawals use hot0 as their sole fee payer. Source, payer, token accounts and ATA creation resources are claimed together. |
| P6-07 | ERC-20/SPL public withdrawal intents retain the original Ledger hold, execute exclusively from hot0, enforce native fee/rent liquidity, and settle principal and actual exchange-paid costs once. |
| P6-08 | Private immutable asset certificates and monotonic configuration revisions gate observation, credit, sweep and withdrawal independently. Code/mint/precision/ownership/transfer mismatches are retained as exceptions. No general contract permission exists. |
| P6-09 | PostgreSQL lifecycle fixtures cover deposit credit, ERC-20 funding, token sweeps, sponsored SPL rent, multiple owned accounts, hot withdrawals, failed-chain fees, duplicate delivery, paused assets, stale watch acknowledgments and reorg compensation. Component tests cover expiry, changed semantics and unavailable history. |

Wallet authorizes spending through a separate Ed25519 authority. Signer verifies typed source, target and sponsor derivations and returns an independently attested result. Broadcast validates that result against the immutable prepared request. Token signing uses the private `transaction.token.sign` command; native queues do not gain arbitrary token transaction capabilities.

Both Ledger and Listener persist token/funding execution intent and return `execution.registry.acknowledged.v1`. Wallet retains signed bytes and resource claims while acknowledgments are missing. Recovery resumes the same signed transaction; it does not create a replacement payout. Source claims and fee reservations retire only after canonical financial settlement is acknowledged.

## Funding and accounting

Management1 pays ERC-20 funding transaction fees and sponsors SPL sweep fees/rent. Funding itself moves native custody to the customer deposit wallet without creating customer liability. Sweeps move token custody to hot0 without changing customer balances. ERC-20 sweep gas is charged against native custody at the customer address; hot withdrawals pay their own native fees.

SPL hot ATA rent is recorded in wallet-owned `custody_rent`; external recipient ATA rent is an exchange expense. Failed transactions post actual fees and return withdrawal principal through the original hold. Reorg compensation reverses principal, fees and rent once, restores that hold, retains execution resources and pauses custody for reconciliation. Signed attempts are never automatically replaced or released on a timeout.

Fee reservations serialize management budgets across workers. Pending, uncertain and reverted exposure remains counted regardless of age. Settled actual spend counts in the trailing 24 hours from settlement time. Initial policy caps remain those in `exchange-financial-v1`: ERC-20 funding principal up to 0.005 ETH per operation, 0.01 ETH per customer wallet and 0.05 ETH per domain per day, with funding fees included in aggregate exposure; SPL sponsorship totals up to 0.01 SOL per operation, 0.02 SOL per customer wallet and 0.1 SOL per domain per day. Fee/rent estimates and retained payer rent also constrain available native liquidity.

Initial management and hot native capital must be funded and represented in Ledger before enabling execution. Automatic treasury replenishment is outside this phase. Low sponsor/hot liquidity retains deferred work or the original withdrawal hold.

## Asset configuration and provider contract

The service-authenticated Wallet route `POST /internal/custody/assets` accepts `certificate`, `configurationRevision`, `symbol`, `name`, and the four flags `observationEnabled`, `creditEnabled`, `sweepEnabled`, `withdrawalEnabled`. Flags default to false; credit requires observation, and sweep requires credit. Asset identity/certificate/precision are immutable. Flag changes require a strictly newer revision. Disabling all flags works during a chain RPC outage; enabling observation or execution validates the certificate against canonical RPC.

Asset registration reaches Listener through `asset.transfer.registry.requested.v1`. Listener installs token-specific watches and returns `asset.transfer.watch.acknowledged.v1` only after historical backfill completes. Native address readiness alone never permits token credit or sweep. Watch generations, configuration revisions, native registry revisions and cursors are durable; stale acknowledgments cannot restore a superseded configuration. SPL discovery includes the derived ATA and other owned token accounts; changes trigger a new watch generation and historical coverage.

The separate QuickNode gateway must implement the [Phase 3 gateway protocol](exchange-wallet-phase3.md#quicknode-gateway-contract) with these additions:

- Certification scope `native-and-transfer-tokens`, with `tokenTransferCoverage: true` and `tokenHistoryCoverage: true`; Solana also requires `ownedTokenAccountCoverage: true`. Ethereum retains `nativeTraceCoverage: true` and the configured `callTracer` verification mode.
- Watch identities include `tokenAssets` containing transfer certificates. Solana identities also include `tokenAccounts` with address, wallet owner, mint and classic program ID.
- Installation, removal and historical pages echo the complete scoped identity, generation and registry revision. Backfill keeps the original history floor, verifies watch/from/through cursors, queues all hashes durably, and advances readiness only on a complete page.
- Existing native-only certification remains insufficient for tokens. Missing provider capability leaves token watches unready and execution blocked.

The gateway implementation/deployment is owned by its separate repository and remains the explicit P3-02 external gate.

## Activation and verification

Deployment requires the per-application migrations, independent execution keys, `ENABLE_TOKEN_EXECUTION=true` for Wallet/Sweep/Broadcast, `ENABLE_TOKEN_SIGNING=true` for Signer, `ALLOW_BROADCAST=true`, valid provider certifications and individually enabled asset flags. All token flags and provider certifications remain disabled/empty by default. Native execution switches remain independent. Only User and Wallet have public application endpoints; the other workers communicate through authenticated queues.

The lifecycle tests use isolated real PostgreSQL databases, authenticated outbox messages, actual Wallet Core signatures and deterministic chain/provider responses. Deposit verification responses are fixtures; canonical RPC verification/observation and malformed-token scenarios have separate adapter tests. Full-suite checks also exercise Redis queue behavior. This is local acceptance, not evidence of live QuickNode/testnet token certification.

No deployment database, real `.env`, production key, provider subscription or real fund was changed. Apply migrations and certify the external gateway and chosen assets during deployment acceptance before activating tokens.

Verification on 12 October: the complete regression run passed **382 tests with zero failures or skips** against six isolated PostgreSQL databases and Redis. Build, ESLint, formatting and diff checks passed. The final focused run passed **32 tests with zero failures or skips**, including a provider-scope regression that verifies that a different provider's token certificate cannot enable the selected gateway, and that Solana requires owned-account coverage.

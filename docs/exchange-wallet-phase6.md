# Phase 6 — Transfer-only token components

Updated: 11 October 2026. **In progress; token lifecycle execution is not enabled.** P6-01 is complete. The remaining tasks require durable resource/funding, queue, registry and financial integration before their checkboxes can be completed.

## Product decisions

ERC-20 support means fixed `transfer(recipient, amount)` operations only. Callers cannot supply calldata, approval/spender instructions, arbitrary contract calls, NFTs, swap/staking instructions or a transaction recipe. Token certification concerns supported asset metadata and exact-transfer semantics; it does not create a whitelist for arbitrary contract interaction.

Payout recipients must be external wallets. Ethereum recipients have no deployed/delegated code at both finalized and pending RPC checks; reserved/precompile addresses are rejected. The existing native execution path rechecks at preparation, authorization revalidation and dispatch preflight. These off-chain reads cannot atomically constrain recipient state changes after checking. SPL recipient owners must be on-curve ordinary System accounts, not program-derived/program-owned accounts. The actual token destination is the owner's derived classic associated token account, necessarily owned by the Token Program. SPL instructions must invoke that program to transfer tokens.

EVM batch contracts and smart-account adapters are removed from the throughput backlog. Sending an ERC-20 still invokes its token contract with internally generated transfer calldata; that is the supported token operation, not permission to interact with contracts generally.

## Implemented components

| Component | Behavior |
| --- | --- |
| `packages/shared/src/token-contracts.ts` | Strict exact-transfer asset certificates and transaction DTOs; pinned Sepolia/Devnet, integer units, typed recipients, management1 sponsorship or hot0 fees, classic SPL program, retained accounts |
| `packages/shared/src/token-authorization.ts` | Separate Ed25519 token authorization signature domain; immutable source/hot/sponsor registry bindings, customer/operation/attempt, original withdrawal reservation identity, request/preparation/certificate digests and expiry |
| `packages/chain/src/token-planner.ts` | Read-only canonical token balances, code hash/precision, simulation, gas/fee/rent quotes, funding shortfall and resource identities; preparation integrity and fresh revalidation |
| `packages/chain/src/token-encoding.ts` | Fixed ERC-20 calldata and independent ethers decoding/recovered source; classic associated-address derivation; exact Wallet Core unsigned SPL messages; bounded wire decoder and verification of both signatures, permissions and instructions |
| `packages/chain/src/token-observer.ts` | Exact signed/canonical transaction matching, finalized inclusion, ERC-20 recipient/amount logs, SPL owned balance deltas, actual native fee payer and recoverable rent; proven orphaning distinct from missing history/outage |
| `packages/chain/src/recipient-policy.ts` | Reserved/precompile rejection and on-curve external Solana owners; used by current native and new token components |
| `apps/signer/src/signing/signing.core.ts` | Wallet Core ERC-20 and sponsored SPL typed signing primitives; private keys derived transiently and key/protobuf buffers erased; independent signed-output checks |
| `apps/signer/src/signing/token-signing.policy.ts` | Independent token spending authority, configured source/hot derivations, certificate/request binding, expiry, management1 sponsor derivation and hot0 withdrawal fee payer |

`ChainModule` exports token preparation/observation as injectable shared services. No new HTTP endpoint or public signer route is introduced. A separate authenticated `transaction.token.sign` command now invokes `TokenSigningPolicy` through the Signer worker and returns independently attested results. `ENABLE_TOKEN_SIGNING` defaults to false and uses the same independent execution authority/attestation key separation. Wallet does not yet produce token commands, and Broadcast token dispatch remains unwired. The existing native signing and withdrawal schemas reject token payloads, so native enablement cannot accidentally enable token execution.

### ERC-20 preparation

Read finalized and pending token/native balances, exact on-chain precision, certified code at both tags, source EOA state, latest/pending nonce and capped fee prices. Build only `transfer` calldata, require a successful boolean return in pending simulation and estimate gas with bounded headroom when adequately funded. If the source lacks the conservative maximum fee reserve, return a capped funding shortfall and require fresh planning after confirmed funding; do not sign or manufacture an unfunded gas estimate.

Hold token principal independently from native fees when this is connected to execution. Revalidation must retain exact principal, nonce and gas limits and repeat recipient/code/balance checks. The observer requires exactly one matching Transfer from the certified token contract to the recipient with the exact amount, rejecting fee-on-transfer outcomes or mismatched code evidence.

### SPL preparation and sponsorship

Discover owned accounts from canonical RPC at finalized commitment, with a slot floor from independent mint validation. Decode classic 82-byte mint/165-byte token-account layouts and verify mint, program, owner, precision, initialization and spendability. Frozen, delegated, wrapped-native, alternate close-authority accounts and Token-2022/extensions remain unsupported. Retain token accounts; no close/refund instruction is authorized.

Customer sweeps use management1 as a separate fee payer; hot0 withdrawals pay their own fees. Derive the recipient's associated token address and either validate the existing account or quote its creation/rent. Fee estimation uses Wallet Core's exact compiled unsigned message. Native fee liquidity includes retained payer rent and newly created token-account rent. Revalidation rejects expired blockhashes, increased costs, missing balances or changed account-creation state; it never refreshes already signed bytes.

The independent decoder accepts only the checked transfer and optional associated-account creation. It verifies both Ed25519 signatures and rejects changed payer, mint, precision, principal, recipient, account permissions and extra programs/instructions. Canonical observation checks exact token deltas and payer-native fee/rent movements. Rent is returned separately from fees because it remains recoverable custody.

## Wallet Core capability evidence

Installed `@trustwallet/wallet-core` **4.8.4** supports Ethereum protobuf `erc20Transfer`, Solana `TokenTransfer`/`CreateAndTransferToken`, external fee payer keys and unsigned message compilation. Actual deterministic fixtures prove:

- Sepolia type-2 ERC-20 with distinct contract/recipient, zero native value and integer amounts above JavaScript's safe-integer range.
- Management1-sponsored classic SPL to an existing or newly created hot associated account, with two independently verified signatures.
- Hot0 SPL withdrawal with its own native fee payer and one independently verified signature.
- Strict rejection of arbitrary calldata, unsupported programs, closure instructions, changed derivations and native-schema admission of token inputs.

Runtime ethers and noble curve dependencies use the existing locked versions, promoted to explicit production dependencies where needed. No replacement signing SDK is required for these primitives. Upgrades must rerun the capability fixtures.

The API shapes follow [Wallet Core's signing guide](https://developer.trustwallet.com/developer/wallet-core/integration-guide/wallet-core-usage) and its [Solana protobuf](https://github.com/trustwallet/wallet-core/blob/master/src/proto/Solana.proto); installed generated types and actual signatures are the compatibility evidence. SPL uses [TransferChecked](https://solana.com/docs/tokens/basics/transfer-tokens) and [owned-account discovery](https://solana.com/docs/rpc/http/gettokenaccountsbyowner).

## Durable financial components added

Wallet now owns `TokenFeeReservation` and an injectable `TokenFeesService`. PostgreSQL serializes each network's management budget across workers. Dependency keys bind source, token, generation and purpose; changed retries cannot replace a reservation. The service validates current source/customer/management1 registrations, persisted exact-transfer certificates and metadata, allowed management actions, native liquidity and operation/customer-wallet/domain caps. Pending, uncertain and reverted exposure remains counted even beyond 24 hours; settled actual spend counts from settlement time. Native liquidity is read while the budget lock is held. This is a reservation API inside Wallet, not funding spend authorization or a connected funding executor.

The migrations retain fee dependency identity and terminal evidence, prohibit releasing uncertain exposure or rewriting settled costs, and persist immutable transfer certificates. Existing enabled token configurations must acquire valid certificates before applying the new certificate constraint. Application databases were not migrated by this work.

Sweep now blocks **known accounted token work** ahead of native drain and checks this dependency again when an unsigned native preparation returns. A token reversal or completed generation can remove the scheduling dependency; duplicate credits cannot create an extra dependency. This does not yet inventory unobserved tokens or implement token residual repair.

Ledger execution events can bind a certified token's native fee payer/revision, approved maximum fee/rent and optional hot-owned rent beneficiary. SPL sweeps debit fees from management1, retain hot ATA rent in a new wallet-owned native `custody_rent` account and move only token principal between custody accounts. SPL withdrawals debit principal against the original customer hold, pay fees from hot0 and expense externally owned ATA creation. Failed transactions post fees only. Canonical reversals compensate fees, rent and principal once and restore the original withdrawal hold. Customer liabilities never pay sponsorship costs. ERC-20 fees must remain with their source wallet and cannot claim rent. Actual costs above approved bounds are recorded with a reconciliation incident rather than disappearing from accounting.

## Remaining work and activation gate

1. **P6-03:** connect the new durable fee reservations to one management funding execution per token-work generation/dependency; reserve execution resources alongside budget/native liquidity; publish the funding identity to Listener/Ledger before dispatch. Retain uncertain funding and require canonical confirmation plus accounting acknowledgment before retrying the dependent sweep. A funding quote alone is not a reservation or spend authorization.
2. **P6-04:** extend the accounted-token scheduling barrier to canonical token inventory, preserve gas/rent, and repair residuals and prevent repeated funding under duplicate triggers, late results and reorgs.
3. **P6-02/P6-05/P6-06:** integrate these components into Wallet authoritative execution/resource fences and purpose-bound Broadcast queue contracts. The private Signer token command is implemented but is not emitted by Wallet. SPL source and sponsor resources must be reserved together; component `resourceKeys` are only identities until persisted and locked.
4. **P6-08 and discovery:** persist approved asset transfer certificates/revisions, extend external provider capabilities beyond native-only scope, map SPL token accounts to registered wallet owners, and keep unsupported observations in visible exceptions. No real token contract or mint was configured by this change.
5. **Ledger:** connect the implemented fee-payer/rent bindings and postings to canonical Wallet token outcomes. The accounting path now has PostgreSQL fixture coverage, but Wallet currently emits native-only execution/settlement events.
6. **P6-07/P6-09:** connect token withdrawal requests to original holds, hot token/native resource reservations, canonical settlement/reversal and recovery; verify the whole deposit → credit → funding → sweep → hot withdrawal flow with PostgreSQL/Redis and chain/provider fixtures.

Keep native execution/broadcast deployment defaults unchanged. Token commands are separate from native signing queues, disabled by default, and not emitted by Wallet. Public withdrawal requests still reject tokens. No deployment databases, `.env`, keys, live provider subscriptions or real funds were changed.

## Verification

Component tests cover capability signatures, typed authorizations, canonical planning, external-wallet restrictions, low native/token liquidity, ownership/precision/code changes, fees/rent, expiry, failed-chain effects, semantic mismatches and reorg/history evidence. The earlier 11 October whole-repository run passed all 367 tests with zero failures/skips using six dedicated PostgreSQL databases and Redis. Verification of the new financial/queue changes is recorded below after the final run. All 24 new token/recipient component tests passed again after quote/decoder refinements. Application/tooling build, ESLint, formatting and diff checks passed. These checks do not claim a completed token funding/financial saga or live chain acceptance.

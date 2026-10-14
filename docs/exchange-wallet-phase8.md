# Phase 8 — Acceptance and controlled rollout

Updated: 14 October 2026.

The repository now has repeatable local acceptance, independent rollout gates, bounded read-only native planning, and explicit signed-transaction smoke runners. **Deployment remains closed.** A local test pass does not certify a live provider or an asset that has not passed its own chain acceptance.

## Rollout policy

Wallet, Ledger, Sweep and Broadcast load the same validated `exchangeRollout` configuration through Nest's global configuration module. Missing configuration fails closed. Keep the policy consistent across their deployments; disagreement pauses work rather than authorizing it.

| Setting | Default | Purpose |
| --- | --- | --- |
| `EXCHANGE_ROLLOUT_MODE` | `closed` | `closed`, `dry-run`, `canary`, or `full` |
| `ENABLE_ADDRESS_ISSUANCE` | `false` | New customer deposit addresses, including the legacy issuance path |
| `ENABLE_DEPOSIT_CREDIT` | `false` | Finality-driven customer credit in Ledger |
| `ENABLE_EXCHANGE_SWEEPS` | `false` | Native/token sweeps and their management funding authorizations |
| `ENABLE_EXCHANGE_WITHDRAWALS` | `false` | Native/token withdrawal admission and execution |
| `EXCHANGE_CANARY_CHAIN` | unset | One chain when mode is `canary` |
| `EXCHANGE_CANARY_NETWORK` | unset | That chain's exact pinned network |

Canary mode requires the configured `EXCHANGE_DOMAIN_ID` and exactly one supported chain/network: Ethereum Sepolia `11155111`, Bitcoin `regtest`, or Solana Devnet `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. Another domain, chain or network cannot issue an address, credit, authorize custody execution or dispatch signed custody bytes. Full mode still retains all existing domain/epoch, asset, customer, financial, recipient and signer controls.

These switches are additional gates. They cannot override `ENABLE_NATIVE_SWEEPS`, `ENABLE_NATIVE_WITHDRAWALS`, `ENABLE_TOKEN_EXECUTION`, `ENABLE_TOKEN_SIGNING`, per-asset capabilities, token certification, fee budgets, frozen customers or custody quarantine. Token withdrawals no longer rely on the token-execution switch alone for rollout admission.

`dry-run` denies sweeps and withdrawals even if their switches are true. Address issuance and customer credit require their own explicit switches; keep both false for a purely read-only rehearsal. Root bootstrap remains available for establishing hot0 and approved management1 identities while customer issuance is closed.

Pausing issuance preserves existing deposit identities and paths. Paused finality delivery is not consumed or journaled; the original event remains retryable. Ledger repair retries retained authenticated current-domain/current-epoch failed jobs after credit resumes. Repair scans move past stale pages without deleting their evidence. Deposit reversals, canonical confirmation, settlement, financial compensation and monitoring remain available during rollback. A switch never releases a customer hold or creates replacement bytes.

## Read-only planning

`GET /internal/operations/preview` requires the existing Wallet backend Bearer credential **and** the distinct `X-Operations-Key` credential. Customer JWTs cannot access it.

The bounded preview samples active ready customer addresses, finds their registered hot0 destination and invokes canonical native planning. It returns principal/fee estimates, resource keys and rollout eligibility. It writes no operations, financial reservations, resource claims, signing messages, broadcast messages or journals. An integration test verifies those counts remain unchanged.

This endpoint is a native planning diagnostic. It does not certify token/native drain ordering, reserve liquidity, authorize a transfer, or replace the actual scheduler's customer/asset/registry checks. RPC errors and insufficient balances remain explicit unavailable/deferred results.

## Repeatable acceptance

Run `npm run acceptance:exchange` from a stable checkout with the six local PostgreSQL services and Redis available.

The runner:

1. Rejects production mode, remote infrastructure and Redis database 0.
2. Creates six uniquely named sibling test databases; it never migrates an application database.
3. Applies every application migration to those disposable databases.
4. Builds every app, type-checks tools/tests, and runs lint and formatting checks.
5. Runs every test serially using real PostgreSQL/Redis and deterministic RPC/provider fixtures.
6. Requires nonempty passing test counts with zero failures, skips or cancellations.
7. Records a source digest before the build and verifies that it is unchanged after testing.
8. Removes its own databases and records any cleanup failure as an acceptance failure.

The default parents are the local development PostgreSQL services on ports 5432–5437. Override the matching `TEST_DATABASE_URL`, `TEST_BROADCAST_DATABASE_URL`, `TEST_LEDGER_DATABASE_URL`, `TEST_ACTIVITY_DATABASE_URL`, `TEST_SWEEP_DATABASE_URL`, `TEST_USER_DATABASE_URL` and `TEST_REDIS_URL` only for dedicated loopback test infrastructure. Database roles need permission to create/drop sibling databases. No shared Redis flush is performed.

Logs and a machine-readable `result.json` are written below ignored `artifacts/acceptance/<run-id>/`. The report contains counts, timestamps, scope, tested-source identity and cleanup failures. Keep this evidence with the release record; do not treat old evidence as certification of subsequently modified source.

The suite covers native/token deposit → one final credit → sweep → hot withdrawal; management gas and SPL rent funding; unchanged liabilities after sweeping; queued low hot liquidity; accounting and custody reconciliation; duplicate/reordered delivery; reservation-event loss; lost Redis acknowledgment; restarted consumers; provider replay; ambiguous submissions; late confirmations; canonical reversals; reset epochs; stale registry/asset evidence; private API authentication; and rollout admission/dispatch restrictions.

## Signed adapter smoke runs

| Runner | Execution and evidence |
| --- | --- |
| `npm run smoke:evm:local` | Owns an ephemeral loopback Anvil node with Sepolia chain ID. Wallet Core signs customer10 → hot0 and hot0 → external11 native transfers. Checks recovered sender, recipient, chain ID, amount, empty calldata, gas bounds, actual gas/fees, exact recipient balance change and canonical finalized inclusion. Mines additional blocks for the finalized head. Requires `anvil` on PATH. |
| `npm run smoke:bitcoin:regtest` | Owns an ephemeral isolated Bitcoin Core regtest directory/node with external peer discovery disabled. Imports watch-only address descriptors, mines mature fixture UTXOs, signs customer10 → hot0 and hot0 → external11, checks decoded outputs/inputs, mempool admission, exact satoshis, fee bounds and six-block finality. Requires `bitcoind` on PATH or an explicit `BITCOIND_PATH`. |
| `npm run smoke:solana:devnet -- --run` | Opt-in public Devnet runner with verified pinned genesis, a random in-memory fixture seed and faucet funds. Simulates then submits one immutable native sweep and one hot withdrawal; checks exact signed canonical evidence and fees through the existing observer. No application seed/database is used. A failed faucet or finality check is not a pass; no replacement is attempted. |

Every run clears its prior success before starting, so a failed rerun cannot leave an old pass as the current result. Smoke evidence is recorded under `artifacts/acceptance/evm-local`, `bitcoin-regtest` and `solana-devnet`. Use the matching timestamp and source release in the acceptance record. The EVM/Bitcoin processes and Bitcoin data directory are removed after each run.

Bitcoin Core 29.0 was obtained from the [official release directory](https://bitcoincore.org/bin/bitcoin-core-29.0/) and checked against its published SHA256SUMS for this local rehearsal. Solana's testnet funding operation follows its [requestAirdrop RPC](https://solana.com/docs/rpc/http/requestairdrop).

Native EVM and Bitcoin smoke tests passed locally on 14 October 2026. Solana's Devnet genesis check succeeded, but `requestAirdrop` returned HTTP 429; its smoke report is **not passed**. ERC-20 and SPL execution remains disabled until real asset certificates and independent node/testnet semantics are accepted; deterministic transfer fixtures are regression evidence, not live token certification.

## Canary launch procedure

1. Select one technical custody domain and one chain/network. Begin with all rollout switches false; deploy compatible code/migrations across the applications.
2. Provision distinct service/operations credentials, execution authority/attestation keys and the pinned seed mapping. Verify hot0, approved management1, fresh customer registry and asset capabilities.
3. Record native fee capital correctly in Ledger. Enable operations monitoring and require fresh reconciled custody reports, reviewed incidents, no shortages/deficits and healthy consumer/outbox age.
4. Complete the separate QuickNode gateway subscription/backfill/replay acceptance for the selected chain. Provider watches remain customer-only.
5. Run local acceptance and that chain's signed smoke on the exact release. Leave uncertified tokens and other networks disabled.
6. Set `EXCHANGE_ROLLOUT_MODE=canary`, the exact canary chain/network and `EXCHANGE_DOMAIN_ID` consistently. Preview native planning with sweeps/withdrawals disabled.
7. Enable address issuance, verify watch/backfill readiness, then enable credit for a small external deposit. Verify exactly one credit and no credit for capital, management funding or hot sweep receipts.
8. Enable sweeps for the canary and verify canonical settlement without changing customer liabilities. Enable withdrawals only after hot custody, fee resources and reconciliation are ready; verify one original hold and one payout.
9. Retain command/message IDs, chain inclusions, journals, reconciliation and acceptance evidence. Expand one capability at a time; entering `full` requires acceptance for every newly eligible network/asset.

No canary or live execution was activated by this implementation.

## Rollback and recovery

Close the rollout gates, or use the audited domain/funding pause when an incident requires it. Stop new withdrawal admission and new spending authorization/dispatch; preserve canonical confirmation and compensation workers. Keep underlying native/token adapter verification enabled while signed or uncertain attempts still exist: switching off those adapters can prevent verification of retained attempts.

Keep published addresses, seeds, custody epoch, operations, signed bytes, resource claims, reservations, journals, outboxes and inbox history. Do not use the development reset, delete queues/databases, alter a derivation path, timeout-release a signed hold or construct a replacement during rollout rollback. Replays must preserve their original authenticated identity. Use the Phase 7 repair/retry/incident commands and runbooks, reconcile the original attempt and require independent Ledger approval before domain recovery. Resuming deployment does not silently thaw a customer.

## Recorded local acceptance — 14 October 2026

The stable-source acceptance run `e807ed783dc44313ba27adb908f29df7` passed **409 tests**, with zero failures, skips or cancellations. All application builds, tool/test type checks, lint and formatting passed. Its six temporary databases were removed; cleanup failures: zero.

- Started: `2026-10-14T12:51:32.663Z`; finished: `2026-10-14T12:53:27.354Z`.
- Source SHA-256: `43e07fc57c34eeed3e789dbe8228be2c3d65665b63f78d1b908f23ef4a109ad4`. This identifies the tested working source, including local changes; it is not a Git commit hash.
- Local EVM signed sweep/withdrawal: passed at `2026-10-14T12:49:23.091Z` using Anvil 1.4.4.
- Bitcoin regtest signed sweep/withdrawal: passed at `2026-10-14T12:49:29.993Z` using Bitcoin Core 29.0.
- Solana Devnet: not passed at `2026-10-14T12:45:54.183Z`; faucet returned RPC/HTTP code `429` before any signed application transfer.
- Runtime evidence: `artifacts/acceptance/e807ed783dc44313ba27adb908f29df7/result.json`, adjacent build/lint/format/test logs, and the three adapter smoke report directories. These runtime files are intentionally ignored by Git; retain them with the release evidence.

No application database was migrated/reset, no application seed was used by the smoke runners, and no rollout switch or provider subscription was activated. Solana used an ephemeral fixture identity for its unsuccessful testnet faucet request; EVM/Bitcoin nodes were disposable local processes.

## Outstanding live gate

P8-02 and the overall launch gate remain open for Solana faucet-funded execution, actual ERC-20/SPL capability certification if those assets will be enabled, public-provider gateway acceptance, and an observed canary on the selected deployment. A passing local suite and local EVM/Bitcoin signatures complete the available repository rehearsal; they do not stand in for those external checks.

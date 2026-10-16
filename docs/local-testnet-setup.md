# Local Docker stack: testnet RPCs

Configured and verified on 16 October 2026. This is the RPC-only setup requested before the separate watch/backfill gateway is deployed. Bitcoin uses the user-selected hosted Testnet3 network; no local Bitcoin node is deployed.

| Chain | Network | Configured public RPC | Verified identity |
| --- | --- | --- | --- |
| Ethereum | Sepolia | `https://ethereum-sepolia-rpc.publicnode.com` | Chain ID `11155111` |
| Solana | Devnet | `https://api.devnet.solana.com` | Genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Bitcoin | Testnet3 | `https://bitcoin-testnet-rpc.publicnode.com` | Core chain `test`, plus pinned Testnet3 genesis |

The endpoints are saved in the private local `.env` and passed to Wallet, Broadcast, ActivityListener and Signer by `compose.apps.yaml`. Signer remains a key-derivation/signing worker; Wallet/Broadcast/ActivityListener use the RPC connections. The custody seed and signing/authentication keys are retained. The user approved resetting development users/history and bootstrapping a fresh Testnet3 custody registry because an existing regtest identity cannot change network/address in place. Pre-cutover environment and database backups are stored privately under `secrets/local-backups/`. Reset rotates the queue epoch and Pub/Sub subscription; previous tokens and smoke-user credentials become stale.

Read-only validation:

```sh
npm run testnet:check
# Check from inside the application network after building the current image:
docker compose -f compose.yaml -f compose.apps.yaml exec -T wallet \
  node dist/scripts/check-testnet-rpc.js
```

The command checks all configured pinned identities, an Ethereum finalized block/base fee, a Solana finalized blockhash/slot, and Bitcoin synchronization/height. Bitcoin verification requires both Core chain `test` and genesis `000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943`, rejecting mainnet, regtest, signet and Testnet4. It prints no provider credentials and does not read the custody seed, request faucet funds, sign or submit transactions. Failure exits nonzero. Public RPCs can rate-limit; replace their URLs with dedicated endpoints in `.env` when available, then recreate the applications with Compose.

The public RPC check is separate from deposit discovery and signed-transaction acceptance. As requested, all execution/rollout gates remain closed, token execution and Bitcoin batching remain disabled (batch authority is currently regtest-only), and the QuickNode certification list remains empty. Starting an RPC connection does not certify its trace/history coverage.

## Remaining setup for automated testnet execution

1. Deploy the separate authenticated QuickNode watch/backfill gateway, connect its publisher to the configured epoch-scoped Pub/Sub topic and certify address watches, history cursors and stable transfer IDs. Ethereum native coverage requires `callTracer`, not only top-level transfers. See [provider protocol](exchange-wallet-phase3.md).
2. Fund the network-specific hot0 and fee-management1 addresses with test coins only. Read the addresses from authenticated `GET /internal/custody`. Never substitute a faucet wallet's seed for the existing custody seed.
3. Finish the real signed-transaction and deposit → credit → sweep → withdrawal acceptance for each selected network, including original-hold settlement and actual fees. The optional Devnet smoke command is `npm run smoke:solana:devnet -- --run`; it uses an unrelated ephemeral seed and faucet funds, not application custody wallets. No faucet or signed-transfer smoke was run as part of this RPC-only configuration.
4. Configure certified native asset capabilities and open a single chain/network canary using the [Phase 8 rollout procedure](exchange-wallet-phase8.md). Do not set fabricated provider certifications or bypass readiness checks.

Sepolia network metadata and faucet links are maintained by [eth-clients](https://github.com/eth-clients/sepolia). Solana documents its [Devnet public endpoint and rate limits](https://solana.com/docs/references/clusters). The configured Sepolia endpoint returned chain ID `0xaa36a7`; the application RPC verifier independently checks its decimal identity.

## Bitcoin network and hosted execution

`CHAIN_NETWORKS={"bitcoin":{"network":"testnet","rpcNetwork":"test"}}` selects Testnet3. Application Bitcoin addresses are `tb1q…` native SegWit P2WPKH; hot0 uses `m/84'/1'/0'/0/0` and customer accounts start at 10. Testnet addresses and regtest `bcrt1…` addresses are rejected across networks. Wallet Core signs the same exact witness scripts through its Bitcoin encoding adapter; decoded recipient, change, fee and input checks remain enforced.

The hosted RPC passed chain/genesis/height and `estimatesmartfee` checks. Its `listunspent` method returned HTTP 501 / RPC `-32701` (method not allowed), so it does not provide the watch-only UTXO view required by the existing planner. Before enabling sweeps/withdrawals, configure and verify hosted address/UTXO discovery with canonical `gettxout` ownership/maturity checks. A chain identity/read pass is not signed-payment or provider certification. Regtest remains available for isolated regression fixtures; deployment does not start a Bitcoin container.

## Verified cutover

The approved reset completed on 16 October 2026: six development schemas were recreated with their migrations, the prior queue namespace/subscription was retired, and the new epoch was bootstrapped. The seed fingerprint was checked unchanged. All five hot/fee wallets reached ready state, including Bitcoin Testnet3 hot0 with a `tb1q` address. Current public addresses are available privately in `secrets/local-testnet-wallets.json`; fresh local test-login credentials are in `secrets/local-smoke-user.json`. Prior credentials/history remain only in the private backups. All seven apps restarted; registration/login, customer projection and private Ledger balance reads passed. The in-container RPC check passed Sepolia, Devnet and Testnet3 network identities and head reads. No Bitcoin node was started, and no chain transaction was broadcast.

Stable-source acceptance run `db9db59bd1d24457902908dbbb2c29ef` passed **458 tests**, zero failures/skips/cancellations, application/tool builds and type checks, lint and formatting. Finished `2026-10-16T12:26:09.863Z`; source SHA-256 `6ee73cb143db5603cee49e8db04ab23f63e32c4851f4c34c7d132c2544d7cad0`; disposable cleanup had zero failures. Evidence is under `artifacts/acceptance/db9db59bd1d24457902908dbbb2c29ef/`. Coverage includes Testnet3 config/derivation/signing/exact output/change verification, chain/genesis rejection, fresh custody bootstrap and immutable-network rejection. The legacy worker transport fixture now isolates its dotenv working directory from deployment configuration. This evidence is not hosted deposit/UTXO discovery or live payment certification.

# Phase 1 — Custody allocation and bootstrap

Updated: 5 October 2026

Phase 1 implementation and local acceptance are complete. Deployment reset/bootstrap remains open under P0-07/P1-07; live RPC and provider acceptance remain separate gates. See the [TODO checklist](exchange-wallet-todo.md).

## Implemented behavior

Wallet owns the authoritative custody domain, its seed identifier/reset epoch, one network per chain, approved management purposes, pinned native asset metadata, and wallet ownership. Seed material and private keys remain exclusively in Signer memory/file configuration.

Bootstrap creates hot account **0** for Sepolia, Bitcoin regtest and Solana Devnet, plus approved gas/fee account **1** for Ethereum and Solana. Bitcoin account1 and accounts2–9 remain unallocated. Explicit reserved inserts do not consume the global customer sequence. Customer accounts begin at **10**, end at **2147483647**, and never cycle.

User registration provisions customer identity through the queue. A deposit-address request persists an assignment intent and queues `custody.assignment.issue`. The Wallet worker allocates the owned wallet and atomically records a Signer command. Bootstrap replay resumes pending assignment work in bounded pages. Advisory locks, unique keys and PostgreSQL role/ownership checks protect concurrent replicas.

Derivation commands/results include wallet/request IDs, a canonical request digest, domain, seed identifier, chain, network, role/account and exact path. Signer validates them against its configuration. Wallet validates the persisted binding, expected path and canonical returned address before updating the wallet, recording immutable publication, and creating separate registry deliveries to Ledger, ActivityListener and Sweep in the same database transaction. Unbound old messages require the coordinated epoch reset.

Published addresses remain unavailable until the authoritative wallet and registry agree, the customer and hot0/required management1 are registered in Ledger, and the listener acknowledges current registry coverage with a completed backfill cursor. Configured seed/domain/epoch, active domain/network, native observation/credit flags, wallet ownership and publication revisions must also agree. These development capability flags do not approve live financial rollout.

Generic `/internal/wallets/:id/transactions` rejects authoritative custody wallets. Phase4/5 must implement authorized sweep/withdrawal execution before any custody wallet sends funds.

## Code and storage

- `apps/wallet/src/custody/`: configuration, bootstrap, approved management creation, allocator, publication gate.
- `apps/wallet/src/custody-api/`: authenticated operator command submission and status.
- `apps/wallet/src/customers/`: assignment intent, queued issuance, authoritative ownership and readiness.
- `apps/wallet/src/messaging/`: custody commands and bound Signer results.
- `apps/wallet/prisma/migrations/20261005210000_custody_allocation/`: new models, composite ownership FKs, role constraints, sequence limits, canonical addresses and immutable identity triggers. Historical migrations are unchanged.
- `packages/queue/src/messages.ts`: strict derivation and custody action schemas; reset-aware authenticated transport remains version2.
- `packages/chain/` and `apps/signer/`: explicit regtest BIP84 coin1, bcrt SegWit v0 validation, signing and RPC network checks. Wallet Core's signing input uses equivalent bc encoding internally; independently decoded scripts/signatures verify the original regtest destinations. Signer configuration omits RPC credentials.

The initial asset/purpose rows persist normative sweep thresholds, total fee caps and funding caps. Runtime funding reservations, EVM gas-price/priority limits, Bitcoin fee-rate bounds, Solana rent caps and the 1% sweep economics rule remain execution work in Phase4/6.

## Operator interfaces

All three routes require the Wallet service credential and remain outside public ingress/OpenAPI:

| Method | Path                                   | Behavior                                                                                                                     |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/internal/custody/bootstrap`          | Accepts `{}`; returns HTTP202 with a command ID; Wallet queue performs bootstrap.                                            |
| POST   | `/internal/custody/management-wallets` | Accepts initial `chain`, exact `network`, `account`1–9 (default1); the worker requires an approved immutable purpose/policy. |
| GET    | `/internal/custody`                    | Reports current domain/epoch and hot/management derivation/publication state.                                                |

Public `POST /v1/me/deposit-addresses` accepts Ethereum, Bitcoin or Solana only on the exact configured development network. The User JWT supplies customer identity. Waiting responses expose no address. Registration/login remain solely in User; internal action workers communicate through authenticated queues.

## Reset and verification

`npm run rehearse:reset` requires explicit `TEST_DATABASE_URL`, `TEST_BROADCAST_DATABASE_URL`, `TEST_LEDGER_DATABASE_URL`, `TEST_ACTIVITY_DATABASE_URL`, `TEST_SWEEP_DATABASE_URL`, `TEST_USER_DATABASE_URL` and `TEST_REDIS_URL`. PostgreSQL roles must be able to create/drop sibling databases. `TEST_PUBSUB_API_ENDPOINT` defaults to loopback port8086. The harness owns fresh databases, queue prefixes and Pub/Sub resources and cleans them up; it never resets the supplied source databases.

Verified against real local PostgreSQL, Redis and the Pub/Sub emulator:

- **250 tests pass with no failures/skips**, including concurrent bootstrap/allocation, first customer10, reserved roles, cross-customer/domain/seed/network rejection, immutable publication/configuration, final-account exhaustion, readiness gates, and real NestJS HTTP/Redis bootstrap/issuance.
- Two actual isolated reset/bootstrap rounds preserve all three deterministic hot addresses, reject old queue envelopes, quarantine a real stale Pub/Sub delivery, and keep Ledger liabilities/journals empty.
- An injected failure after the third owned database retains the startup fence; resume keeps the same planned epoch, removes old work, and preserves unrelated/current resources.
- Application/tooling build, ESLint, formatting, Compose configuration and whitespace checks pass.

## Remaining deployment acceptance

No actual deployment `.env`, seed, application records or provider watches were changed. The local `.env` lacks four service database URLs, current reset/domain settings and application authentication settings. Merge the applicable `.env.example` configuration while preserving the existing seed; select Bitcoin regtest explicitly and use distinct service/queue credentials and separate User token keys.

Before applying the coordinated reset, verify workers are stopped and the external publisher is stopped with old provider watches retired, or establish that it was never connected. The workspace cannot prove that external state. The reset command requires those factual acknowledgments:

```sh
npm run reset:development
npm run reset:development -- --apply --workers-stopped --publisher-stopped --provider-watches-removed
```

After successful reset, start the configured workers and submit the authenticated bootstrap command. Verify owned hot/management addresses, first customer10 and empty liabilities. Configure and certify live RPC identities, QuickNode Ethereum/Solana discovery/watch/backfill, and the local Bitcoin Core gateway before exposing ready customer addresses. The current native deposit rollout cannot bypass these gates. See the [reset procedure](exchange-wallet-initial-decisions.md#p0-07--complete-the-asynchronous-state-reset) and [provider protocol](exchange-wallet-phase3.md#quicknode-gateway-contract).

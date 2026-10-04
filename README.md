# Wallet as a Service

A NestJS 12 ESM monorepo with **wallet, signer, broadcast, activity-listener, and ledger services**, PostgreSQL through **Prisma 7**, and durable Redis queues through **`@nestjs/bullmq`**. Trust Wallet Core handles derivation and transaction signing. The provider-facing [blockchain transaction listener](https://github.com/EmmanuelAmodu/blockchain-transaction-listener) remains a separate publisher; this monorepo consumes its Google Cloud Pub/Sub activity topic.

## Architecture

```mermaid
flowchart LR
  Client -->|Authenticated HTTP commands / queries| Wallet[Wallet service]
  Wallet --> DB[(Wallet PostgreSQL / Prisma)]
  DB -->|Transactional outbox relay| Redis[(Redis / BullMQ)]
  Redis -->|Derive / sign commands| Signer[Signer service]
  Signer -->|Derived / signed / rejected events| Redis
  Redis -->|Prepare commands / signer and broadcast events| Wallet
  Redis -->|Broadcast / confirm commands| Broadcast[Broadcast service]
  Broadcast --> BroadcastDB[(Broadcast PostgreSQL / Prisma)]
  BroadcastDB -->|Transactional outbox / status events| Redis
  Broadcast -->|Reconcile / submit / monitor| Nodes[Blockchain RPC]
  Wallet -->|Nonce / gas / UTXO / blockhash reads| Nodes
  ProviderListener[Provider webhook listener] -->|on-chain-activity| PubSub[Google Cloud Pub/Sub]
  PubSub --> Activity[Activity listener]
  Activity --> ActivityDB[(Activity PostgreSQL / Prisma)]
  ActivityDB -->|Transactional outbox| Redis
  Activity -->|finality checks| Nodes
  Activity -->|Provisional / final / reversal events| Redis
  Redis --> Ledger[Ledger service]
  Ledger --> LedgerDB[(Ledger PostgreSQL / Prisma)]
  Wallet -->|Authenticated balance API| Ledger
  Signer --> Seed[Read-only master seed]
```

| Service | Responsibilities | Dependencies |
| --- | --- | --- |
| `apps/wallet` | Exchange customer API and deposit history, legacy tenant API, wallet records, idempotency, transaction preparation, processing signer results, queuing broadcast/refresh actions | Its own Prisma/PostgreSQL, Redis, Ledger HTTP, read RPCs |
| `apps/signer` | Consume derivation/signing commands; derive ephemeral keys; publish results | Redis, Wallet Core, seed file; **no database or RPC** |
| `apps/broadcast` | Reconcile hashes, submit stored signed bytes, exponential retries, Solana simulation/expiry checks, confirmation monitoring | Prisma/PostgreSQL, Redis, RPCs; **no seed or signing responsibilities** |
| `apps/activity-listener` | Persist exchange registry/watch coverage, consume discovery signals, verify canonical transfers/finality, recover gaps, and publish deposit/incident events | Its own Prisma/PostgreSQL, Pub/Sub, Redis, provider gateway, configured chain RPCs; **no private keys** |
| `apps/ledger` | Own the wallet registry, double-entry debit/credit journal, per-entry running balances, and internal balance API | Its own Prisma/PostgreSQL database, Redis; **no signer or provider credentials** |

The wallet service does not submit transactions or call the signer over HTTP. Signer, broadcast, and activity-listener are Nest application contexts with queue/Pub/Sub consumers, not HTTP servers. Ledger has an internal HTTP API on `127.0.0.1:3010` by default; Wallet calls it using `LEDGER_API_KEY`. Wallet, broadcast, ledger, and activity-listener each own a separate database, Prisma schema, migration history, and client. No service queries another service's database. Registry and financial commands use transactional outboxes and consumer-owned inboxes. The signer remains stateless and needs no database. Broadcast status and deposit history in Wallet are eventually consistent; balances are served by Ledger.

**Redis/BullMQ was chosen for action queues with durable jobs, retries, and competing workers.** This does not use Redis Pub/Sub or Nest's ephemeral Redis microservice transport. Kafka is not required for this implementation.

## NestJS organization

Each application has a root `AppModule` that composes feature modules. Wallet exposes separate wallet and transaction controllers/services. Queue processors delegate to application services, configuration is injected through `@nestjs/config`, and each database is encapsulated by its own Prisma module. HTTP authentication uses a global Nest guard, request validation uses DTO schemas with Nest pipes, and error handling uses an injected global filter.

See [the architecture guide](docs/architecture.md) for the module map, dependency rules, lifecycle behavior, and guidance for adding features. `nest-cli.json` defines the five Nest CLI applications. Chain identifiers and network names are stored as strings, and transaction intents are stored as JSON, so adding an allowlisted chain does not require a wallet database migration. Bearer prefixes are required, and invalid `ALLOW_BROADCAST` values fail startup instead of silently disabling broadcasting.

## Action flow

1. Creating a wallet atomically stores a `deriving` wallet and a `wallet.derive` outbox command. The signer publishes `wallet.derived`; a wallet worker saves the address and sets `ready`.
2. Creating a transaction atomically reserves the wallet, saves the intent as `preparing`, and queues `transaction.prepare` through the outbox. A wallet worker obtains chain data, persists the prepared transaction, and queues `transaction.sign`.
3. The signer returns a `transaction.signed` event. The wallet worker persists the signed bytes and transaction hash, then sets `signed`.
4. An explicit broadcast request changes the wallet record to `queued` and stores `broadcast.requested` with an immutable signed payload, network, and any Solana expiry height in the wallet outbox.
5. A broadcast worker reconciles the hash before sending. It only submits the **persisted signed bytes**. It persists the signed payload in its own database, commits revisioned `broadcast.updated` events alongside state changes, and schedules delayed `broadcast.confirm` commands through the outbox until finality or an operator-action state.
6. `wallet.derived` also queues `ledger.wallet.registered` in the same wallet DB transaction. The Ledger worker stores the wallet/address mapping in its own database.
7. The external provider listener publishes activity to Pub/Sub. ActivityListener verifies supported network identity/finality and queues provisional, finalized, failed, or reverted updates. Ledger deduplicates by transaction identifier, journals base-unit deltas, and updates provisional/confirmed balance projections.

Private keys and seed phrases are never placed in queue jobs or database records. Queue payloads do contain addresses, paths, transaction intents, and signed bytes; treat Redis as sensitive infrastructure. Commands and results carry versioned, HMAC-authenticated envelopes using `QUEUE_AUTH_KEY`.

The wallet worker deduplicates broadcast events and checks generation and revision before updating its local projection. Out-of-order events cannot regress newer state, and wallet reservations remain held until a terminal event arrives. If the wallet service is offline, broadcast and confirmation continue independently; events wait durably in Redis.

## Chain support

| Chain | Derivation | Implemented transfers | Network |
| --- | --- | --- | --- |
| EVM family (61 Wallet Core coin types) | Wallet Core coin path | Native asset, EIP-1559 | Configure each chain ID and RPC endpoint |
| Bitcoin and Bitcoin Cash families (16 coin types) | Wallet Core coin path | Native UTXO transfers, 1–50 outputs plus change | Mainnet, Bitcoin Core-compatible RPC |
| Solana | `m/44'/501'/account'` | 1–20 native SOL transfer instructions, legacy transaction size checked | Configured genesis hash; default devnet |

The default network identities are Sepolia, Bitcoin mainnet, and Solana devnet; the RPC URLs are blank until configured. Configure additional supported networks in `CHAIN_NETWORKS`, a JSON object keyed by a [supported chain identifier](packages/shared/src/contracts.ts). EVM entries require `network`, `chainId`, and `rpcUrl`; Bitcoin-family entries require `network: "mainnet"` and a Bitcoin Core-compatible `rpcUrl`. The same map must be supplied to wallet, signer, broadcast, and activity-listener services; signer reads only EVM chain IDs. `rpcUser` and `rpcPassword` are used for Bitcoin-family Basic authentication, `rpcNetwork` selects the expected Bitcoin Core network name, and `confirmations` overrides the EVM/Bitcoin confirmation defaults.

For example, configure Polygon and Litecoin with `CHAIN_NETWORKS={"polygon":{"network":"137","chainId":"137","rpcUrl":"https://polygon-rpc.example"},"litecoin":{"network":"mainnet","rpcUrl":"http://127.0.0.1:9332","rpcUser":"wallet","rpcPassword":"replace-me"}}`. Only add endpoints you control or trust. Bitcoin-family callers supply outpoints; the wallet service obtains values and scripts from the node and checks ownership, confirmation, and coinbase maturity. UTXO discovery is not included. Validate each fork’s RPC compatibility and fee policy on a test network before production use.

### Preparation and safety checks

- Before preparation and broadcast, the service verifies the RPC network: EVM chain ID, Bitcoin Core network name, or Solana genesis hash must match configuration.
- EVM preparation reads the pending nonce, estimates gas with 20% headroom, and rejects a wallet balance that cannot cover the transfer plus the maximum gas fee. The priority fee must not exceed the maximum fee.
- Bitcoin-family requests must provide unique outpoints. The service fetches each UTXO and rejects spent, foreign, or unconfirmed outputs; coinbase outputs require 100 confirmations. Signer rechecks the locking script and recipient addresses before signing.
- Solana preparation uses a finalized blockhash and records its last-valid height. Broadcast checks expiry and simulates the signed transaction before submission. The signer rejects the system-program address as a recipient and enforces the 1,232-byte legacy packet limit.

## Activity and ledger

The linked provider listener publishes `ProcessorOnChainActivity` messages to Pub/Sub. ActivityListener consumes `PUBSUB_SUBSCRIPTION`, validates the event, maps its `wallet:<chain>:<address>` identifiers, checks the chain/network through configured RPC, then sends updates through the authenticated Ledger queue. It accepts Wallet-Service chain identifiers plus the source listener's `bsc` alias (`smartChain`); networks outside the wallet chain contract, including the source's Tron and XRPL adapters, are retained as failed `activity-actions` jobs rather than written under an incorrect chain.

Ledger has a separate database and uses double-entry journal lines per asset and balance state. Wallet postings use debit-normal balances; system clearing postings provide the counter-entry for net inflows/outflows. Base-unit amounts are bounded integer strings and all aggregation/running-balance arithmetic uses `bigint`; Prisma Decimal is used only for exact database serialization. Each journal line has a positive debit or credit amount, an account key, sequence, `balance_after`, a predecessor link, and an optional reversal reference. Appends serialize on the account key and derive the next sequence and balance from the latest journal entry; there is no separate account cursor table or mutable next pointer. The balance API reads the latest entry for each wallet account key. Canonical chain, network, and transaction hash deduplicate provider redelivery. Redis-atomic observation sequences prevent delayed jobs from replacing newer states. Legacy events without sequences use sequence zero; after a sequenced observation exists, legacy events are rejected with a reconciliation error. Reconcile using the original provider activity identifier through ActivityListener instead of retrying the stale Ledger envelope. A finalized posting can be reversed only by a later successful canonical reconciliation. EVM defaults to 12 confirmations, Bitcoin-family chains to 6, and Solana to `finalized`; EVM/Bitcoin depths use per-chain `confirmations` overrides. Activity finality polling defaults to 30 seconds for up to 120 checks, followed by five-minute recovery checks (`ACTIVITY_RECONCILIATION_POLL_MS`). Finality jobs retain prior inclusion even when only a Solana slot is available, including across RPC retries. A previously included transaction that remains in mempool moves back to provisional; one no longer found by the canonical RPC is reverted. Operators can resume retained finality checks with `npm run queue -- reconcile activity-actions ACTIVITY_IDENTIFIER`. A failed EVM or Solana transaction posts only its network fee; a reverted Bitcoin transaction reverses its observed posting.

`GET /v1/wallets/:id/balances` returns `confirmed` and `provisional` decimal strings in the asset's smallest unit. Wallet-Service calls the internal Ledger API with the authenticated tenant identity; it never reads the ledger database. `LEDGER_API_KEY` must be distinct from both tenant API keys and `QUEUE_AUTH_KEY` in production. The local setup script generates a separate key.

Ledger is event-derived, not an on-chain balance snapshot: it starts tracking an address when the wallet is registered and does not backfill earlier history or discover all current token holdings. A newly registered or legacy wallet can therefore report zero until its activity is delivered. EVM spending checks and UTXO availability continue to use chain RPC; Ledger balances are reporting/accounting projections, not spend authorization.

The Wallet-Service transaction API sends native assets only: Ethereum atomic multi-recipient batching needs a batch contract or smart-account adapter; ERC-20/SPL sending, arbitrary calldata, multisig/Taproot, and cross-wallet batching are not implemented. The separate activity listener and ledger may still record token balance changes supplied by the provider listener; these are reported in the asset's base units and are not spend authorization.

**A path does not replace the master seed.** The signer reads a BIP39 mnemonic from a mode-0600 file and keeps its Wallet Core HD wallet in process memory. Derived key objects are deleted and accessible buffers overwritten after use; JS/WASM cannot guarantee erasure of every runtime copy. Never change a mnemonic under an existing `SIGNER_SEED_ID`. All signer replicas consuming the same queue must have the same seed and configuration.

## Local setup

Requires Node.js **22.22.3+ within Node 22, 24.15+ within Node 24, or Node 26+**, PostgreSQL 14+, and Redis 7+. Docker Compose provides PostgreSQL 17 and Redis 7.4 with AOF persistence, synchronous fsync, and `noeviction`.
Wallet, Broadcast, Ledger, and ActivityListener each own a PostgreSQL database. The local stack also includes the Google Cloud Pub/Sub emulator.

```sh
npm ci
npm run setup:local
docker compose up -d postgres broadcast-postgres ledger-postgres activity-postgres redis pubsub
npm run setup:pubsub
npm run migrate
npm run build
```

`setup:local` creates a fresh seed in `secrets/local.mnemonic`, a stable random `RESET_EPOCH`, and distinct random tenant, queue, and Ledger API credentials in `.env`, with private file permissions. It refuses to overwrite existing files. The generated `PUBSUB_TOPIC` and `PUBSUB_SUBSCRIPTION` include an epoch suffix; `setup:pubsub` creates exactly those values from `.env`, not fixed resource names. Configure the external provider publisher with `PUBSUB_PROJECT_ID` and `PUBSUB_TOPIC`; every discovery payload must include a top-level `resetEpoch` equal to the configured `RESET_EPOCH`. ActivityListener quarantines events with a missing or stale epoch, even on the current topic. The current external listener's `NODE_ENV=development` mode writes activities to `./output` instead of Pub/Sub, so local end-to-end ingestion requires its Pub/Sub-publishing mode and epoch field. Configure RPC URLs and `CHAIN_NETWORKS` for the chains you use. Address derivation uses Wallet Core metadata; transaction preparation and activity finality checks require configured RPC endpoints.

For an intentional local reset, stop all application workers and the external publisher and remove provider watches. Preview with `npm run reset:development`. Applying it resets only the configured loopback-owned service databases, retires the old project queue namespace/subscription, and rotates `.env`; it is destructive. The tool reads durable `.env` state directly, so reset/resume uses the persisted plan even when shell exports are stale. An exclusive `.env.reset.lock` with an owner token protects destructive work; epoch and marker checks protect the final clearing of `RESET_IN_PROGRESS`; concurrent apply/resume commands are rejected. If it fails, keep workers stopped and resume with `npm run reset:development -- --resume --apply --workers-stopped --publisher-stopped --provider-watches-removed`. Resume uses the same persisted epoch and retired namespaces. A lock left by an exited process requires explicit stale-lock recovery; never remove a live owner's lock or manually clear the reset marker. Services refuse startup while a reset lock or `RESET_IN_PROGRESS` exists, and reject a runtime epoch that conflicts with durable state. Reconfigure the external publisher and verify provider backfill/readiness before restarting workers.

The durable reset file defaults to `.env` in the working directory. Set `RESET_ENV_FILE` to use another file, supplying the same path to every service, the queue CLI, and the reset tool. An explicitly configured missing file blocks startup. This setting selects the reset state file; normal application settings still come from the existing environment/configuration loader.

Run each service in a separate terminal:

```sh
npm run dev:wallet
npm run dev:signer
npm run dev:broadcast
npm run dev:activity-listener
npm run dev:ledger
```

These commands generate Prisma clients and run Nest CLI in watch mode. `npm run build` builds all applications; `npm run build:wallet`, `build:signer`, `build:broadcast`, `build:activity-listener`, and `build:ledger` build one application. Production start scripts are `start:wallet`, `start:signer`, `start:broadcast`, `start:activity-listener`, and `start:ledger`, with environment variables supplied externally.

Wallet-Service exposes the tenant API at `127.0.0.1:3000` by default. Swagger is public at `/docs` and OpenAPI JSON at `/docs-json`; wallet routes require tenant bearer authentication. Ledger exposes its internal API at `127.0.0.1:3010` by default and authenticates Wallet-Service with `LEDGER_API_KEY`. ActivityListener and the signer/broadcast workers expose no HTTP routes. Set `WALLET_HOST` and `LEDGER_HOST` to `0.0.0.0` inside containers when appropriate. `ALLOW_BROADCAST=false` is enforced by the **broadcast service**. An action submitted while broadcasting is disabled reaches `attention` without sending funds.

### Database configuration

- Wallet: `WALLET_DATABASE_URL`, local PostgreSQL on port 5432.
- Broadcast: `BROADCAST_DATABASE_URL`, separate local PostgreSQL on port 5433.
- Ledger: `LEDGER_DATABASE_URL`, separate local PostgreSQL on port 5434.
- Signer: no database URL or database access.
- ActivityListener: `ACTIVITY_DATABASE_URL`, separate local PostgreSQL on port 5435.

`npm run migrate` migrates Wallet, Broadcast, Ledger, and ActivityListener databases. For independent deployment use `npm run migrate:wallet`, `npm run migrate:broadcast`, `npm run migrate:ledger`, or `npm run migrate:activity`, supplying only that application's URL. Each service should receive only its own database credentials. Separate databases may live on one PostgreSQL server with separate roles and access restrictions, or on separate servers as in Compose.

### Migration Reset

The earlier development reset established fresh Wallet, Broadcast, and Ledger baselines. Phase 2 preserves those baselines and adds exchange registry/accounting migrations plus an ActivityListener baseline. Normal migration deployment applies these changes without resetting databases. The coordinated development reset remains a separate destructive setup procedure.

The baseline migration files are generated under each service's `apps/<service>/prisma/migrations` directory. Run `npm run migrate` to apply all four databases’ migrations, or use the application-specific migration commands separately. Each service continues to use its own database credentials. The wrapper no longer recognizes or baselines the former `schema_migrations` history.

The local reset preserved the existing seed and `.env` credentials, but recreated the service databases and their test databases. Configure `REDIS_URL`, `QUEUE_PREFIX`, required `RESET_EPOCH`, `QUEUE_AUTH_KEY`, a distinct production `LEDGER_API_KEY`, Pub/Sub project/topic/subscription settings, and provider RPC/network settings for any new environment. All workers and the external publisher must use the same epoch, and provider payloads must carry it as top-level `resetEpoch`. Do not mix old and new workers or replay old queue jobs against the fresh schemas.

## Exchange accounting

Phase 2 provides tenant-free customer liabilities and holds, immutable balanced journals, durable per-consumer registry delivery, and Ledger outbox/reconciliation. See [Phase 2 implementation notes](docs/exchange-wallet-phase2.md) for the internal API, migration setup, and verification. Customer address publication remains blocked until Phase 1 custody bootstrap and Phase 3 provider coverage are complete.

Phase 3 adds `/v1/customers` APIs using `EXCHANGE_API_KEY` and `EXCHANGE_DOMAIN_ID`, durable address-watch/backfill readiness, RPC-verified transfer identities, reorg compensation, and custody-loss freezes. Customer creation registers its identity with Ledger through the queue; balances return HTTP 202 until acknowledgment. Address assignment waits for a registered customer account >=10 and all custody, Ledger, and listener coverage prerequisites. QuickNode is selected for Ethereum/Solana; its gateway implementation and live certification in the external listener repository remain open. Bitcoin regtest has a separate observation gateway. Certificates default to empty, and no customer address is exposed without verified coverage. See [Phase 3 implementation notes](docs/exchange-wallet-phase3.md) for API routes, configuration, the gateway contract, and remaining rollout gates.

## API changes

Tenant bearer keys remain configured with `WALLET_API_KEYS`, a JSON map from tenant ID to key. Tenant identity is derived from authentication, never from request bodies. `QUEUE_AUTH_KEY` must be different from tenant API keys.

Swagger documents all seven tenant-authenticated routes, accepted request shapes, asynchronous responses, and the required `Idempotency-Key` header for transfer creation.

**Command endpoints now return `202 Accepted`, not a completed synchronous result.** Poll the corresponding GET endpoint. Wallet creation can return `address: null` with `status: deriving`; wait for `ready` before requesting a transfer. Transaction acceptance does not guarantee preparation or signing succeeded; check the resulting status and generic `last_error` before requesting broadcast.

| Method | Route | Result |
| --- | --- | --- |
| POST | `/v1/wallets` | Accept or return wallet creation by tenant/external ID/chain/network |
| GET | `/v1/wallets/:id` | Wallet status, address, derivation metadata |
| GET | `/v1/wallets/:id/balances` | Confirmed and provisional Ledger balances by asset |
| POST | `/v1/wallets/:id/transactions` | Accept preparation/signing; requires `Idempotency-Key` |
| GET | `/v1/transactions/:id` | Intent, prepared/signed data, hash, status, attempt count, generic error |
| POST | `/v1/transactions/:id/broadcast` | Queue broadcast, or retry an `attention` transaction with a new generation |
| POST | `/v1/transactions/:id/refresh` | Restart bounded confirmation monitoring for a signed `attention` transaction |

For example:

```sh
export API_KEY="$(node --env-file=.env -p 'JSON.parse(process.env.WALLET_API_KEYS).local')"
curl http://127.0.0.1:3000/v1/wallets \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"chain":"ethereum","externalId":"customer-001"}'
```

After the returned wallet is `ready`, save a transfer body as `transfer.json` and submit it:

```sh
curl "http://127.0.0.1:3000/v1/wallets/$WALLET_ID/transactions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: payment-001' --data-binary @transfer.json
```

Read confirmed and provisional balances through the tenant API:

```sh
curl "http://127.0.0.1:3000/v1/wallets/$WALLET_ID/balances" \
  -H "Authorization: Bearer $API_KEY"
```

Amounts and Ethereum fee values are **decimal strings in base units**: wei for EVM, satoshis for Bitcoin-family chains, and lamports for Solana. Example bodies below contain placeholder recipients/outpoints that must be replaced.

```json
{"chain":"ethereum","to":"0xREPLACE_WITH_40_HEX_CHARACTERS","amount":"1000000000000000","maxFeePerGas":"30000000000","maxPriorityFeePerGas":"1000000000"}
```

```json
{"chain":"bitcoin","outputs":[{"address":"bc1qRECIPIENT_ONE","amount":"10000"},{"address":"bc1qRECIPIENT_TWO","amount":"20000"}],"utxos":[{"txid":"64_LOWERCASE_HEX_CHARACTERS","vout":0}],"satsPerVbyte":2}
```

```json
{"chain":"solana","outputs":[{"address":"BASE58_RECIPIENT_ONE","amount":"1000000"},{"address":"BASE58_RECIPIENT_TWO","amount":"2000000"}]}
```

Wait for `signed`, enable broadcasting on the broadcast service when ready, and POST to `/v1/transactions/TRANSACTION_ID/broadcast`. Submission and monitoring then run asynchronously.

## Delivery, retries, and scale

- **Transactional outbox:** state changes and their next action commit together in PostgreSQL. Wallet and broadcast replicas run relays using `FOR UPDATE SKIP LOCKED`. A Redis outage leaves actions unpublished for a later attempt. Relays publish stable job IDs before marking delivery; a lost acknowledgement can safely cause redelivery.
- **Pub/Sub handoff:** ActivityListener acknowledges a provider Pub/Sub message only after the activity is accepted into its deterministic BullMQ job. Pub/Sub redelivery therefore reuses the same job ID; the provider listener remains outside this repository.
- **At-least-once processing:** this is not an exactly-once transport. Deterministic job IDs, durable signer-result inbox records, status checks, generation checks, and a partial unique database index absorb duplicates. Signed bytes remain immutable across broadcast retries.
- **Reservations:** one pending transaction per wallet, including `attention`, across all replicas. Rejected preparation/signing releases the reservation; uncertain sends do not. This prevents this system's nonce/UTXO conflicts, provided these wallets are not spent from externally.
- **Workers:** wallet, broadcast, and ledger concurrency is 8 per replica; activity-listener concurrency is 4; signer concurrency is 1 because cryptography is synchronous. Add replicas with the same application-specific database, queue prefix, Redis, Pub/Sub subscription, network config, and appropriate secret credentials. Distinct environments require distinct databases and queue namespaces.
- **Retries:** 8 attempts with exponential backoff, starting at `QUEUE_RETRY_DELAY_MS` (default 1,000 ms). Failed jobs are retained for inspection/replay. Completed jobs are retained for up to a day, capped at 10,000 per queue; database guards still apply after queue cleanup.
- **Monitoring:** delayed confirmation commands default to 30 seconds, with up to 120 reschedules per monitoring run. EVM networks default to 12 confirmations and Bitcoin-family networks to 6; configure per-chain overrides in `CHAIN_NETWORKS`. Solana waits for `finalized`. Bitcoin Core needs transaction-history lookup, typically `txindex=1`.
- **Shutdown:** workers drain active jobs before releasing signer/database resources. A terminated worker's stalled job can be recovered by BullMQ.

```text
wallet:      deriving → ready | rejected
transaction: preparing → signing → signed → queued → broadcasting → submitted → confirmed
                   ↘ rejected                                  ↘ attention    ↘ failed
```

`failed` denotes a final failure reported by a chain RPC: an EVM receipt with failure status after the configured confirmation depth, or a finalized Solana transaction error. The Bitcoin-family adapter currently reports `unknown`, `submitted`, or `confirmed`, not `failed`. `attention` denotes retry exhaustion, disabled broadcasting, expired Solana blockhash, configuration mismatch, or exhausted monitoring; it **continues to reserve the wallet**. Refresh is available only in `attention` to start another bounded status-check run; queued, broadcasting, and submitted transactions continue their existing automatic polling. When it is safe to retry, request broadcast again to enqueue a new generation using the same signed bytes. An expired Solana blockhash cannot be fixed by rebroadcasting those bytes; it needs operational reconciliation because automatic re-signing is not supported. A refresh gets its own monitoring-run ID, so old completed poll jobs cannot suppress it.

There is no automatic re-signing, fee replacement, reservation deletion, or assumption that a missing transaction failed. Stale-generation jobs cannot update a newer retry. If the original outcome cannot be established, keep the reservation and reconcile operationally.

Inspect retained failed jobs without printing payloads:

```sh
npm run queue -- failed broadcast-actions
npm run queue -- retry broadcast-actions JOB_ID
npm run queue -- reconcile activity-actions transaction:ethereum:TRANSACTION_HASH
```

The CLI can also inspect `wallet-actions`, `signer-actions`, `activity-actions`, and `ledger-actions`. Rejected preparation/signing needs a corrected request with a new idempotency key; replaying a command whose database state is already terminal is a no-op. Queue authentication failures require correcting the producer/key configuration, not blindly retrying.

PostgreSQL outbox/inbox records are retained for recovery and currently have no automatic cleanup policy. Redis persistence/backups remain necessary: the outbox protects the database-to-queue handoff, not total loss of acknowledged Redis data. Restore Redis or deliberately replay affected outbox actions after such a loss. Do not flush production queues. The shared queue key authenticates internal messages; it is not an independent tenant spending-policy engine.

## Prisma and deployment

`apps/wallet/prisma`, `apps/broadcast/prisma`, `apps/ledger/prisma`, and `apps/activity-listener/prisma` contain independent schemas and migrations. Their configuration files are `prisma.config.ts`, `prisma.broadcast.config.ts`, `prisma.ledger.config.ts`, and `prisma.activity.config.ts`. `npm run db:generate` generates all four clients. Ordinary queries and writes use Prisma Client with the PostgreSQL adapter. Database sessions use UTC so delayed actions retain their intended timestamps. Small parameterized raw queries remain for row/advisory locks, `SKIP LOCKED`, and the existing non-recycling account sequence. Partial unique indexes and CHECK constraints are maintained in migration SQL; do not replace migrations with `db push`.

The Dockerfile provides a non-root runtime for any service. Override its command for signer, broadcast, activity-listener, or ledger. Build the `migrate` target to run `node dist/scripts/migrate.js` with the Prisma CLI available. Mount the seed read-only only in signer containers, owned by UID 1000 with mode 0600. Do not mount it in wallet, broadcast, activity-listener, or ledger containers.

Use managed credentials, Redis ACLs/TLS (`rediss://` supported), private network access, backups, and monitoring in deployment. Production seed-vault/HSM/MPC integration, independent payment policies, audit events/webhooks, automated replacement/reorg recovery, and token adapters remain follow-up work. The included Compose credentials are local-development defaults.

Prisma CLI transitive dependencies `deepmerge-ts` and `mysql2` are pinned through scoped npm overrides to patched versions. Migration and generation commands are tested with those overrides.

## Verification

```sh
npm test
# Use dedicated test databases and Redis; integration tests otherwise skip explicitly.
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/wallet_test \
TEST_BROADCAST_DATABASE_URL=postgresql://user:password@localhost:5433/broadcast_test \
TEST_LEDGER_DATABASE_URL=postgresql://user:password@localhost:5434/ledger_test \
TEST_ACTIVITY_DATABASE_URL=postgresql://user:password@localhost:5435/activity_test \
TEST_REDIS_URL=redis://localhost:6379 npm test
npm run format:check
npm run lint
npm audit
```

Tests run serially against four dedicated test databases. Exchange journal fixtures use unique domains and preserve append-only history; legacy fixtures clean only their own records. The outbox interruption test creates and drops its own temporary database, so the dedicated Ledger test role needs database-creation permission. The integration suite starts real NestJS processes and multiple broadcast replicas, uses real Redis and PostgreSQL, and mocks blockchain RPC. Ledger integration tests cover deduplication, provisional-to-confirmed promotion, attention recovery, and reorg reversal; ActivityListener tests cover finality mapping and RPC retry exhaustion. It exercises offline consumers, async signing, signature verification, retries, lost responses after acceptance, duplicate delivery, tenant isolation, idempotency, outbox recovery, generation checks, reservation retention, and automatic confirmation. Pub/Sub ingestion is unit-tested; no test sends live funds. CI supplies all four PostgreSQL databases and Redis. Phase 2 tests cover simultaneous holds, per-asset balancing, immutable journals, duplicate/reordered events, deficit freezing, custody-only movements, actual fees, settlement reversal, registry acknowledgments, and a lost Redis acknowledgment after a committed reservation.

References: [NestJS queues](https://docs.nestjs.com/techniques/queues), [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [Prisma PostgreSQL integration](https://www.prisma.io/docs/orm/overview/databases/postgresql), [Prisma baselining](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining), [Wallet Core usage](https://developer.trustwallet.com/developer/wallet-core/integration-guide/wallet-core-usage).

# Wallet as a Service

A NestJS monorepo with **wallet, signer, and broadcast services**, PostgreSQL through **Prisma 7**, and durable Redis queues through **`@nestjs/bullmq`**. Trust Wallet Core handles derivation and transaction signing.

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
  Signer --> Seed[Read-only master seed]
```

| Service | Responsibilities | Dependencies |
| --- | --- | --- |
| `apps/wallet` | Tenant API, wallet records, idempotency, transaction preparation, processing signer results, queuing broadcast/refresh actions | Prisma/PostgreSQL, Redis, read RPCs |
| `apps/signer` | Consume derivation/signing commands; derive ephemeral keys; publish results | Redis, Wallet Core, seed file; **no database or RPC** |
| `apps/broadcast` | Reconcile hashes, submit stored signed bytes, exponential retries, Solana simulation/expiry checks, confirmation monitoring | Prisma/PostgreSQL, Redis, RPCs; **no seed or signing responsibilities** |

The wallet service does not submit transactions or call the signer over HTTP. The signer and broadcast services are Nest application contexts with `@Processor` / `WorkerHost` consumers, not HTTP servers. Shared packages contain Prisma access, queue contracts/outbox, input validation, and read-only chain preparation code. Wallet and broadcast each own a separate database, Prisma schema, migration history, and Prisma client. Neither service reads or writes the other database. The signer remains stateless and needs no database. Broadcast status in the wallet API is an eventually consistent projection of queue events.

**Redis/BullMQ was chosen for action queues with durable jobs, retries, and competing workers.** This does not use Redis Pub/Sub or Nest's ephemeral Redis microservice transport. Kafka is not required for this implementation.

## Action flow

1. Creating a wallet atomically stores a `deriving` wallet and a `wallet.derive` outbox command. The signer publishes `wallet.derived`; a wallet worker saves the address and sets `ready`.
2. Creating a transaction atomically reserves the wallet, saves the intent as `preparing`, and queues `transaction.prepare` through the outbox. A wallet worker obtains chain data, persists the prepared transaction, and queues `transaction.sign`.
3. The signer returns a `transaction.signed` event. The wallet worker persists the signed bytes and transaction hash, then sets `signed`.
4. An explicit broadcast request changes the wallet record to `queued` and stores `broadcast.requested` with an immutable signed payload, network, and any Solana expiry height in the wallet outbox.
5. A broadcast worker reconciles the hash before sending. It only submits the **persisted signed bytes**. It persists the signed payload in its own database, commits revisioned `broadcast.updated` events alongside state changes, and schedules delayed `broadcast.confirm` commands through the outbox until finality or an operator-action state.

Private keys and seed phrases are never placed in queue jobs or database records. Queue payloads do contain addresses, paths, transaction intents, and signed bytes; treat Redis as sensitive infrastructure. Commands and results carry versioned, HMAC-authenticated envelopes using `QUEUE_AUTH_KEY`.

The wallet worker deduplicates broadcast events and checks generation and revision before updating its local projection. Out-of-order events cannot regress newer state, and wallet reservations remain held until a terminal event arrives. If the wallet service is offline, broadcast and confirmation continue independently; events wait durably in Redis.

## Chain support

| Chain | Derivation | Implemented transfers | Network |
| --- | --- | --- | --- |
| Ethereum | `m/44'/60'/account'/0/0` | Native ETH, EIP-1559 | Configured chain ID; default Sepolia |
| Bitcoin | `m/84'/0'/account'/0/0` | Native SegWit, 1–50 payment outputs plus change | Mainnet only |
| Solana | `m/44'/501'/account'/0'` | 1–20 native SOL transfer instructions, legacy transaction size checked | Configured genesis hash; default devnet |

Bitcoin callers supply outpoints. The wallet service obtains values and scripts from the node and checks ownership, confirmation, and coinbase maturity. Wallet Core signs and constructs the batch/change outputs. UTXO discovery is not yet included.

Ethereum atomic multi-recipient batching needs a batch contract or smart-account adapter, which is outside this version. ERC-20, SPL tokens, arbitrary calldata, multisig/Taproot, and cross-wallet batching are also outside this version.

**A path does not replace the master seed.** The signer reads a BIP39 mnemonic from a mode-0600 file and keeps its Wallet Core HD wallet in process memory. Derived key objects are deleted and accessible buffers overwritten after use; JS/WASM cannot guarantee erasure of every runtime copy. Never change a mnemonic under an existing `SIGNER_SEED_ID`. All signer replicas consuming the same queue must have the same seed and configuration.

## Local setup

Requires Node.js **22.12+**, PostgreSQL 14+, and Redis 7+. Docker Compose provides PostgreSQL 17 and Redis 7.4 with AOF persistence, synchronous fsync, and `noeviction`.

```sh
npm ci
npm run setup:local
docker compose up -d postgres broadcast-postgres redis
npm run migrate
npm run build
```

`setup:local` creates a fresh seed in `secrets/local.mnemonic` and distinct random tenant and queue credentials in `.env`, with private file permissions. It refuses to overwrite existing files. Configure the RPC URLs for the chains you use. Address derivation needs no RPC; transaction preparation does.

Run each service in a separate terminal:

```sh
npm run dev:wallet
npm run dev:signer
npm run dev:broadcast
```

These commands compile and start; they are not watch processes. Production start scripts are `start:wallet`, `start:signer`, and `start:broadcast`, with environment variables supplied externally.

Only the wallet service exposes HTTP, at `127.0.0.1:3000` by default. Set `WALLET_HOST=0.0.0.0` inside a container when appropriate. `ALLOW_BROADCAST=false` is enforced by the **broadcast service**. An action submitted while broadcasting is disabled reaches `attention` without sending funds.

### Database configuration

- Wallet: `WALLET_DATABASE_URL`, local PostgreSQL on port 5432.
- Broadcast: `BROADCAST_DATABASE_URL`, separate local PostgreSQL on port 5433.
- Signer: no database URL or database access.

`npm run migrate` migrates both databases. For independent deployment use `npm run migrate:wallet` or `npm run migrate:broadcast`, supplying only that application's URL. Each service should receive only its own database credentials. Separate databases may live on one PostgreSQL server with separate roles and access restrictions, or on separate servers as in Compose.

### Upgrading the earlier version

This changes the broadcast queue contract. Before upgrading an existing deployment, stop accepting new work and drain active broadcasts and confirmation monitoring using the old services. Resolve all `attention` transactions first; do not discard reservations or uncertain payments. Stop the old workers and relays before deploying the new version. Do not mix old and new workers. Retained old broadcast jobs lack signed snapshots and must not be replayed into the new consumers.

Keep the existing seed, seed ID, and wallet database. Rename `DATABASE_URL` to `WALLET_DATABASE_URL` and provision a fresh, separate `BROADCAST_DATABASE_URL`. No existing database is deleted or copied by these scripts. Add `REDIS_URL`, `QUEUE_PREFIX`, and `QUEUE_AUTH_KEY` to your environment; remove obsolete `SIGNER_URL`, `SIGNER_PORT`, and `SIGNER_HOST`. The old internal `SIGNER_TOKEN` can be renamed to `QUEUE_AUTH_KEY` if it is already a distinct random secret of at least 32 characters. Do not rerun local seed setup on an existing installation.

Run `npm run migrate` before starting the new services. The migration wrapper recognizes the original `schema_migrations` entry for `001_initial.sql`, marks its identical Prisma baseline as applied, then applies the additive event-driven migration. Existing addresses become `ready`; transaction data, derivation accounts, and the sequence are retained. Unknown legacy migration histories are rejected for manual review. Fresh wallet databases apply the full wallet migration history; broadcast has an independent initial migration.

## API changes

Tenant bearer keys remain configured with `WALLET_API_KEYS`, a JSON map from tenant ID to key. Tenant identity is derived from authentication, never from request bodies. `QUEUE_AUTH_KEY` must be different from tenant API keys.

**Command endpoints now return `202 Accepted`, not a completed synchronous result.** Poll the corresponding GET endpoint. Wallet creation can return `address: null` with `status: deriving`; wait for `ready` before requesting a transfer.

| Method | Route | Result |
| --- | --- | --- |
| POST | `/v1/wallets` | Accept or return wallet creation by tenant/external ID/chain/network |
| GET | `/v1/wallets/:id` | Wallet status, address, derivation metadata |
| POST | `/v1/wallets/:id/transactions` | Accept preparation/signing; requires `Idempotency-Key` |
| GET | `/v1/transactions/:id` | Intent, prepared/signed data, hash, status, attempt count, generic error |
| POST | `/v1/transactions/:id/broadcast` | Queue broadcast, or retry an `attention` transaction with a new generation |
| POST | `/v1/transactions/:id/refresh` | Queue a fresh confirmation-monitoring run |

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

Amounts and Ethereum fee values are **decimal strings in base units**. Example bodies below contain placeholder recipients/outpoints that must be replaced.

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
- **At-least-once processing:** this is not an exactly-once transport. Deterministic job IDs, durable signer-result inbox records, status checks, generation checks, and a partial unique database index absorb duplicates. Signed bytes remain immutable across broadcast retries.
- **Reservations:** one pending transaction per wallet, including `attention`, across all replicas. Rejected preparation/signing releases the reservation; uncertain sends do not. This prevents this system's nonce/UTXO conflicts, provided these wallets are not spent from externally.
- **Workers:** wallet and broadcast concurrency is 8 per replica; signer concurrency is 1 per replica because cryptography is synchronous. Add replicas with the same application-specific database, queue prefix, Redis, network config, and appropriate secret credentials. Distinct environments require distinct databases and queue namespaces.
- **Retries:** 8 attempts with exponential backoff, starting at `QUEUE_RETRY_DELAY_MS` (default 1,000 ms). Failed jobs are retained for inspection/replay. Completed jobs are retained for up to a day, capped at 10,000 per queue; database guards still apply after queue cleanup.
- **Monitoring:** delayed confirmation commands default to 30 seconds, with up to 120 reschedules per monitoring run. Ethereum requires 12 confirmations, Bitcoin 6, and Solana `finalized`. Bitcoin Core needs transaction-history lookup, typically `txindex=1`.
- **Shutdown:** workers drain active jobs before releasing signer/database resources. A terminated worker's stalled job can be recovered by BullMQ.

```text
wallet:      deriving → ready | rejected
transaction: preparing → signing → signed → queued → broadcasting → submitted → confirmed
                   ↘ rejected                                  ↘ attention    ↘ failed
```

`failed` denotes finalized on-chain failure. `attention` denotes retry exhaustion, disabled broadcasting, expired Solana blockhash, configuration mismatch, or exhausted monitoring; it **continues to reserve the wallet**. Refresh to discover the existing payment's outcome. After resolving the cause, request broadcast again to enqueue a new generation using the same signed bytes. A refresh gets its own monitoring-run ID, so old completed poll jobs cannot suppress it.

There is no automatic re-signing, fee replacement, reservation deletion, or assumption that a missing transaction failed. Stale-generation jobs cannot update a newer retry. If the original outcome cannot be established, keep the reservation and reconcile operationally.

Inspect retained failed jobs without printing payloads:

```sh
npm run queue -- failed broadcast-actions
npm run queue -- retry broadcast-actions JOB_ID
```

The CLI can also inspect `wallet-actions` and `signer-actions`. Rejected preparation/signing needs a corrected request with a new idempotency key; replaying a command whose database state is already terminal is a no-op. Queue authentication failures require correcting the producer/key configuration, not blindly retrying.

PostgreSQL outbox/inbox records are retained for recovery and currently have no automatic cleanup policy. Redis persistence/backups remain necessary: the outbox protects the database-to-queue handoff, not total loss of acknowledged Redis data. Restore Redis or deliberately replay affected outbox actions after such a loss. Do not flush production queues. The shared queue key authenticates internal messages; it is not an independent tenant spending-policy engine.

## Prisma and deployment

`apps/wallet/prisma` and `apps/broadcast/prisma` contain independent schemas and migrations. `prisma.config.ts` configures wallet; `prisma.broadcast.config.ts` configures broadcast. `npm run db:generate` generates both clients. Ordinary queries and writes use Prisma Client with the PostgreSQL adapter. Database sessions use UTC so delayed actions retain their intended timestamps. Small parameterized raw queries remain for row/advisory locks, `SKIP LOCKED`, and the existing non-recycling account sequence. Partial unique indexes and CHECK constraints are maintained in migration SQL; do not replace migrations with `db push`.

The Dockerfile provides a non-root runtime for any service. Override its command for signer or broadcast. Build the `migrate` target to run `node dist/scripts/migrate.js` with the Prisma CLI available. Mount the seed read-only only in signer containers, owned by UID 1000 with mode 0600. Do not mount it in wallet or broadcast containers.

Use managed credentials, Redis ACLs/TLS (`rediss://` supported), private network access, backups, and monitoring in deployment. Production seed-vault/HSM/MPC integration, independent payment policies, audit events/webhooks, automated replacement/reorg recovery, and token adapters remain follow-up work. The included Compose credentials are local-development defaults.

Prisma CLI transitive dependencies `deepmerge-ts` and `mysql2` are pinned through scoped npm overrides to patched versions. Migration and generation commands are tested with those overrides.

## Verification

```sh
npm test
# Use a dedicated test database and Redis; DB/queue tests otherwise skip explicitly.
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/wallet_test \
TEST_BROADCAST_DATABASE_URL=postgresql://user:password@localhost:5433/broadcast_test \
TEST_REDIS_URL=redis://localhost:6379 npm test
npm run format:check
npm run lint
npm audit
```

Tests run serially against two dedicated test databases and clean their records. The integration suite starts real NestJS processes and multiple broadcast replicas, uses real Redis and PostgreSQL, and mocks blockchain RPC only. It exercises offline consumers, async signing, signature recovery, retries, lost responses after acceptance, duplicate result delivery, tenant isolation, idempotency, outbox recovery, generation checks, reservation retention, and automatic confirmation. No test sends live funds. CI supplies PostgreSQL and Redis.

References: [NestJS queues](https://docs.nestjs.com/techniques/queues), [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [Prisma PostgreSQL integration](https://www.prisma.io/docs/orm/overview/databases/postgresql), [Prisma baselining](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining), [Wallet Core usage](https://developer.trustwallet.com/developer/wallet-core/integration-guide/wallet-core-usage).

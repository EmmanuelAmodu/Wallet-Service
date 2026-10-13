# Exchange wallet infrastructure

A NestJS 12 ESM monorepo for one crypto exchange, with **user, wallet, sweep, signer, broadcast, activity-listener, and ledger services**, six service-owned PostgreSQL databases through **Prisma 7**, and durable Redis queues through **`@nestjs/bullmq`**. Trust Wallet Core handles derivation and transaction signing. The provider-facing [blockchain transaction listener](https://github.com/EmmanuelAmodu/blockchain-transaction-listener) remains a separate publisher; this monorepo consumes its Google Cloud Pub/Sub activity topic. There is one exchange owner and no tenant model or tenant selection.

## Architecture

```mermaid
flowchart LR
  Customer -->|Register / login| User[User service]
  User -->|Access token| Customer
  Customer -->|Bearer JWT| Wallet[Wallet service]
  User --> UserDB[(User PostgreSQL / Prisma)]
  UserDB -->|user.registered via transactional outbox| Redis[(Redis / BullMQ)]
  Backend[Private exchange backend] -->|Service-authenticated internal HTTP| Wallet
  Wallet --> DB[(Wallet PostgreSQL / Prisma)]
  DB -->|Transactional outbox relay| Redis
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
  LedgerDB -->|Credited deposits and custody review events| Redis
  Redis --> Sweep[Sweep service]
  Sweep --> SweepDB[(Sweep PostgreSQL / Prisma)]
  Wallet -->|Authenticated balance API| Ledger
  Signer --> Seed[Read-only master seed]
```

| Service                  | Responsibilities                                                                                                                                                                                                      | Dependencies                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/user`              | Register/login users, verify passwords, issue access tokens; publish identity-only registration events                                                                                                                | Its own Prisma/PostgreSQL, Redis; **no custody, signer, or blockchain access**                          |
| `apps/wallet`            | Project User registrations into financial customers, expose JWT-authenticated customer APIs and private operational APIs, own wallet records, idempotency, transaction preparation, and signer/broadcast coordination | Its own Prisma/PostgreSQL, Redis, Ledger HTTP, read RPCs                                                |
| `apps/sweep`             | Coalesce accounted native deposits by source wallet/asset, persist registry dependencies and custody review gates; execution remains disabled until Phase 4                                                           | Its own Prisma/PostgreSQL, Redis; **no current signing, broadcasting, or chain execution**              |
| `apps/signer`            | Consume derivation/signing commands; derive ephemeral keys; publish results                                                                                                                                           | Redis, Wallet Core, seed file; **no database or RPC**                                                   |
| `apps/broadcast`         | Reconcile hashes, submit stored signed bytes, exponential retries, Solana simulation/expiry checks, confirmation monitoring                                                                                           | Prisma/PostgreSQL, Redis, RPCs; **no seed or signing responsibilities**                                 |
| `apps/activity-listener` | Persist exchange registry/watch coverage, consume discovery signals, verify canonical transfers/finality, recover gaps, and publish deposit/incident events                                                           | Its own Prisma/PostgreSQL, Pub/Sub, Redis, provider gateway, configured chain RPCs; **no private keys** |
| `apps/ledger`            | Mirror the wallet registry; own customer liabilities, the double-entry journal, per-entry running balances, and internal balance API                                                                                  | Its own Prisma/PostgreSQL database, Redis; **no signer or provider credentials**                        |

The wallet service does not submit transactions or call the signer over HTTP. Signer, broadcast, activity-listener, and sweep are Nest application contexts with queue/Pub/Sub consumers, not HTTP servers. Only User and Wallet publish public application HTTP endpoints. User exposes registration/login at `127.0.0.1:3001`; Wallet verifies User tokens locally with only the public key. Ledger has a private authenticated HTTP read API on `127.0.0.1:3010` by default, called by Wallet using `LEDGER_API_KEY`. User, Wallet, Sweep, Broadcast, Ledger, and ActivityListener each own a separate database, Prisma schema, migration history, and client. No service queries another service's database. Registration, registry, and financial events use transactional outboxes and consumer-owned inboxes. The signer remains stateless and needs no database. User provisioning, broadcast status, and deposit history in Wallet are eventually consistent; balances are served by Ledger.

ActivityListener observes deposits and verifies their chain evidence; Ledger credits the customer once at finality, then notifies Sweep. ActivityListener also detects reorgs and unexpected outflows for accounting and custody review. It does not decide sweep policies. Sweep scheduling hints are not chain balances or spending authority: Phase 4 must add actual balance/UTXO reads, fee/rent policy, reservations, signing orchestration, and recovery before funds can move automatically.

**Redis/BullMQ was chosen for action queues with durable jobs, retries, and competing workers.** This does not use Redis Pub/Sub or Nest's ephemeral Redis microservice transport. Kafka is not required for this implementation.

## NestJS organization

Each application has a root `AppModule` that composes feature modules. Wallet exposes separate wallet and transaction controllers/services. Queue processors delegate to application services, configuration is injected through `@nestjs/config`, and each database is encapsulated by its own Prisma module. HTTP authentication uses a global Nest guard, request validation uses DTO schemas with Nest pipes, and error handling uses an injected global filter.

See [the architecture guide](docs/architecture.md) for the module map, dependency rules, lifecycle behavior, and guidance for adding features. `nest-cli.json` defines seven Nest CLI applications. Chain identifiers and network names are stored as strings, and transaction intents are stored as JSON, so adding an allowlisted chain does not require a wallet database migration. Backend bearer prefixes are required, and invalid `ALLOW_BROADCAST` values fail startup instead of silently disabling broadcasting.

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

| Chain                                             | Derivation            | Implemented transfers                                                  | Network                                  |
| ------------------------------------------------- | --------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| EVM family (61 Wallet Core coin types)            | Wallet Core coin path | Native asset, EIP-1559                                                 | Configure each chain ID and RPC endpoint |
| Bitcoin and Bitcoin Cash families (16 coin types) | Wallet Core coin path | Native UTXO transfers, 1–50 outputs plus change                        | Mainnet, Bitcoin Core-compatible RPC     |
| Solana                                            | `m/44'/501'/account'` | 1–20 native SOL transfer instructions, legacy transaction size checked | Configured genesis hash; default devnet  |

The default network identities are Sepolia, Bitcoin mainnet, and Solana devnet; the RPC URLs are blank until configured. Configure additional supported networks in `CHAIN_NETWORKS`, a JSON object keyed by a [supported chain identifier](packages/shared/src/contracts.ts). EVM entries require `network`, `chainId`, and `rpcUrl`; Bitcoin-family entries require `network: "mainnet"` and a Bitcoin Core-compatible `rpcUrl`. The same map must be supplied to wallet, signer, broadcast, and activity-listener services; signer reads only EVM chain IDs. `rpcUser` and `rpcPassword` are used for Bitcoin-family Basic authentication, `rpcNetwork` selects the expected Bitcoin Core network name, and `confirmations` overrides the EVM/Bitcoin confirmation defaults.

For example, configure Polygon and Litecoin with `CHAIN_NETWORKS={"polygon":{"network":"137","chainId":"137","rpcUrl":"https://polygon-rpc.example"},"litecoin":{"network":"mainnet","rpcUrl":"http://127.0.0.1:9332","rpcUser":"wallet","rpcPassword":"replace-me"}}`. Only add endpoints you control or trust. Bitcoin-family callers supply outpoints; the wallet service obtains values and scripts from the node and checks ownership, confirmation, and coinbase maturity. UTXO discovery is not included. Validate each fork’s RPC compatibility and fee policy on a test network before production use.

### Preparation and safety checks

- Before preparation and broadcast, the service verifies the RPC network: EVM chain ID, Bitcoin Core network name, or Solana genesis hash must match configuration.
- EVM preparation reads the pending nonce, estimates gas with 20% headroom, and rejects a wallet balance that cannot cover the transfer plus the maximum gas fee. The priority fee must not exceed the maximum fee.
- Bitcoin-family requests must provide unique outpoints. The service fetches each UTXO and rejects spent, foreign, or unconfirmed outputs; coinbase outputs require 100 confirmations. Signer rechecks the locking script and recipient addresses before signing.
- Solana preparation uses a finalized blockhash and records its last-valid height. Broadcast checks expiry and simulates the signed transaction before submission. The signer rejects the system-program address as a recipient and enforces the 1,232-byte legacy packet limit.

## Activity and ledger

Exchange customer deposits use strict versioned discovery hints, customer-address watch/backfill coverage, and RPC-verified transfers. Ethereum deposit credit requires canonical finalized-head evidence, Bitcoin regtest requires six confirmations, and Solana requires finalized transactions. An RPC outage or missing historical data does not reverse an existing credit; reversal requires proven canonical evidence. Ledger notifies Sweep only after accounting commits. The [Phase 3 notes](docs/exchange-wallet-phase3.md) describe this exchange flow and provider gates.

The compatibility activity path for operational wallet records accepts the linked provider listener's `ProcessorOnChainActivity` messages through Pub/Sub. ActivityListener consumes `PUBSUB_SUBSCRIPTION`, validates the event, maps its `wallet:<chain>:<address>` identifiers, checks the chain/network through configured RPC, then sends updates through the authenticated Ledger queue. It accepts Wallet-Service chain identifiers plus the source listener's `bsc` alias (`smartChain`); networks outside the wallet chain contract, including the source's Tron and XRPL adapters, are retained as failed `activity-actions` jobs rather than written under an incorrect chain. The confirmation and wallet-balance behavior below describes this compatibility path.

Ledger has a separate database and uses double-entry journal lines per asset and balance state. Wallet postings use debit-normal balances; system clearing postings provide the counter-entry for net inflows/outflows. Base-unit amounts are bounded integer strings and all aggregation/running-balance arithmetic uses `bigint`; Prisma Decimal is used only for exact database serialization. Each journal line has a positive debit or credit amount, an account key, sequence, `balance_after`, a predecessor link, and an optional reversal reference. Appends serialize on the account key and derive the next sequence and balance from the latest journal entry; there is no separate account cursor table or mutable next pointer. The balance API reads the latest entry for each wallet account key. Canonical chain, network, and transaction hash deduplicate provider redelivery. Redis-atomic observation sequences prevent delayed jobs from replacing newer states. Legacy events without sequences use sequence zero; after a sequenced observation exists, legacy events are rejected with a reconciliation error. Reconcile using the original provider activity identifier through ActivityListener instead of retrying the stale Ledger envelope. A finalized posting can be reversed only by a later successful canonical reconciliation. EVM defaults to 12 confirmations, Bitcoin-family chains to 6, and Solana to `finalized`; EVM/Bitcoin depths use per-chain `confirmations` overrides. Activity finality polling defaults to 30 seconds for up to 120 checks, followed by five-minute recovery checks (`ACTIVITY_RECONCILIATION_POLL_MS`). Finality jobs retain prior inclusion even when only a Solana slot is available, including across RPC retries. A previously included transaction that remains in mempool moves back to provisional; one no longer found by the canonical RPC is reverted. Operators can resume retained finality checks with `npm run queue -- reconcile activity-actions ACTIVITY_IDENTIFIER`. A failed EVM or Solana transaction posts only its network fee; a reverted Bitcoin transaction reverses its observed posting.

`GET /internal/wallets/:id/balances` returns `confirmed` and `provisional` decimal strings in the asset's smallest unit. Wallet-Service calls the internal Ledger API using its service credential; it never reads the ledger database or forwards a tenant identity. `LEDGER_API_KEY`, `WALLET_API_KEY`, `EXCHANGE_API_KEY`, and `QUEUE_AUTH_KEY` are separate credentials. The local setup script generates distinct keys.

Ledger is event-derived, not an on-chain balance snapshot: it starts tracking an address when the wallet is registered and does not backfill earlier history or discover all current token holdings. A newly registered or legacy wallet can therefore report zero until its activity is delivered. EVM spending checks and UTXO availability continue to use chain RPC; Ledger balances are reporting/accounting projections, not spend authorization.

Legacy Wallet transaction endpoints send native assets only. EVM batch contracts, smart-account adapters, arbitrary calldata and approvals are excluded by the transfer-only recipient policy. Exchange customer withdrawals support certified transfer-only ERC-20/SPL assets behind independent, disabled-by-default token execution flags. Multisig/Taproot and cross-wallet batching remain unsupported. The separate activity listener and ledger may still record token balance changes supplied by the provider listener; these are reported in the asset's base units and are not spend authorization.

**A path does not replace the master seed.** The signer reads a BIP39 mnemonic from a mode-0600 file and keeps its Wallet Core HD wallet in process memory. Derived key objects are deleted and accessible buffers overwritten after use; JS/WASM cannot guarantee erasure of every runtime copy. Never change a mnemonic under an existing `SIGNER_SEED_ID`. All signer replicas consuming the same queue must have the same seed and configuration.

## Local setup

Requires Node.js **22.22.3+ within Node 22, 24.15+ within Node 24, or Node 26+**, PostgreSQL 14+, and Redis 7+. Docker Compose provides PostgreSQL 17 and Redis 7.4 with AOF persistence, synchronous fsync, and `noeviction`.
User, Wallet, Sweep, Broadcast, Ledger, and ActivityListener each own a PostgreSQL database. The local stack also includes the Google Cloud Pub/Sub emulator.

```sh
npm ci
npm run setup:local
docker compose up -d postgres broadcast-postgres ledger-postgres activity-postgres sweep-postgres user-postgres redis pubsub
npm run setup:pubsub
npm run migrate
npm run build
```

`setup:local` creates a fresh seed in `secrets/local.mnemonic`, a separate 3072-bit RSA token key pair in `secrets/user-token-private.pem` and `secrets/user-token-public.pem`, a stable random `RESET_EPOCH`, one `EXCHANGE_DOMAIN_ID`, all six database URLs, and distinct Wallet backend, exchange backend, queue, and Ledger API credentials in `.env`, with private file permissions. It refuses to overwrite existing files. For an existing `.env`, replace the old `WALLET_API_KEYS` map with one distinct `WALLET_API_KEY`, remove the obsolete map, and add `USER_DATABASE_URL`, `SWEEP_DATABASE_URL`, `EXCHANGE_DOMAIN_ID`, and `EXCHANGE_API_KEY` using [.env.example](.env.example). Configure `AUTH_TOKEN_PRIVATE_KEY_FILE` for User and the matching `AUTH_TOKEN_PUBLIC_KEY_FILE` for Wallet; see [authentication setup](docs/user-authentication.md) for existing environments. Keep the current seed ID and reset epoch for a normal upgrade. This change does not modify an existing `.env` or reset deployment databases automatically.

Fresh `setup:local` also creates two independent Ed25519 execution key pairs. Existing installations can run `npm run setup:execution-policy` to create these files without replacing any existing execution key or changing the custody seed, `.env`, or reset epoch. Add the four `EXECUTION_*_KEY_FILE` paths from [.env.example](.env.example) to your configuration. Wallet receives only the execution authority private key and Signer public key; Signer receives the authority public key and its own private attestation key; Broadcast receives only the Signer public key. Keep `ENABLE_NATIVE_SWEEPS=false` and `ALLOW_BROADCAST=false` until the relevant rollout gates are satisfied. `EXECUTION_RECONCILIATION_MS`, `SWEEP_RECONCILIATION_MS`, and `SWEEP_RETRY_DELAY_MS` control bounded repair scheduling. The optional setup command accepts `--directory PATH` for a separate key directory and refuses partial existing key sets as well as complete ones.

For containerized development, after infrastructure, Pub/Sub, and migrations are ready, use the application overlay. Supply your host UID/GID so owner-only key files remain readable without changing their permissions:

```sh
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) \
  docker compose -f compose.yaml -f compose.apps.yaml up --build
```

Only User 3001 and Wallet 3000 are published; Ledger remains private and other workers have no HTTP listener. Each app receives its own database URL and only its required secret mounts. This overlay uses development credentials; public ingress must exclude Wallet `/internal/*`. Application image/startup was not exercised in this change.

The generated `PUBSUB_TOPIC` and `PUBSUB_SUBSCRIPTION` include an epoch suffix; `setup:pubsub` creates exactly those values from `.env`, not fixed resource names. Configure the external provider publisher with `PUBSUB_PROJECT_ID` and `PUBSUB_TOPIC`; every discovery payload must include a top-level `resetEpoch` equal to the configured `RESET_EPOCH`. ActivityListener quarantines events with a missing or stale epoch, even on the current topic. The current external listener's `NODE_ENV=development` mode writes activities to `./output` instead of Pub/Sub, so local end-to-end ingestion requires its Pub/Sub-publishing mode and epoch field. Configure RPC URLs and `CHAIN_NETWORKS` for the chains you use. Address derivation uses Wallet Core metadata; transaction preparation and activity finality checks require configured RPC endpoints.

For an intentional local reset, stop all application workers and the external publisher and remove provider watches. Preview with `npm run reset:development`. Applying it resets only the configured loopback-owned service databases, retires the old project queue namespace/subscription, and rotates `.env`; it is destructive. The tool reads durable `.env` state directly, so reset/resume uses the persisted plan even when shell exports are stale. An exclusive `.env.reset.lock` with an owner token protects destructive work; epoch and marker checks protect the final clearing of `RESET_IN_PROGRESS`; concurrent apply/resume commands are rejected. If it fails, keep workers stopped and resume with `npm run reset:development -- --resume --apply --workers-stopped --publisher-stopped --provider-watches-removed`. Resume uses the same persisted epoch and retired namespaces. A lock left by an exited process requires explicit stale-lock recovery; never remove a live owner's lock or manually clear the reset marker. Services refuse startup while a reset lock or `RESET_IN_PROGRESS` exists, and reject a runtime epoch that conflicts with durable state. Reconfigure the external publisher and verify provider backfill/readiness before restarting workers.

The durable reset file defaults to `.env` in the working directory. Set `RESET_ENV_FILE` to use another file, supplying the same path to every service, the queue CLI, and the reset tool. An explicitly configured missing file blocks startup. This setting selects the reset state file; normal application settings still come from the existing environment/configuration loader.

Run each service in a separate terminal:

```sh
npm run dev:wallet
npm run dev:signer
npm run dev:broadcast
npm run dev:activity-listener
npm run dev:ledger
npm run dev:sweep
npm run dev:user
```

These commands generate Prisma clients and run Nest CLI in watch mode. `npm run build` builds all seven applications; the `build:wallet`, `build:signer`, `build:broadcast`, `build:activity-listener`, `build:ledger`, `build:sweep`, and `build:user` scripts build one application. Corresponding `start:<application>` scripts run the compiled service, with environment variables supplied externally.

Wallet exposes JWT-authenticated customer APIs under `/v1/me` at `127.0.0.1:3000`. Public Swagger `/docs` and OpenAPI `/docs-json` describe only customer routes. Operational `/internal/wallets` and `/internal/transactions` require `WALLET_API_KEY`; `/internal/customers` uses the separate `EXCHANGE_API_KEY`. Deny these internal paths at public ingress. User exposes registration/login at `127.0.0.1:3001`. Ledger is a private read API at `127.0.0.1:3010`, authenticated with `LEDGER_API_KEY`; it must have no public ingress. ActivityListener, Sweep, and signer/broadcast workers expose no HTTP routes. Set the relevant `WALLET_HOST`, `USER_HOST`, or `LEDGER_HOST` to `0.0.0.0` inside containers when appropriate. `ALLOW_BROADCAST=false` is enforced by the **broadcast service**. An action submitted while broadcasting is disabled reaches `attention` without sending funds.

### Database configuration

- Wallet: `WALLET_DATABASE_URL`, local PostgreSQL on port 5432.
- Broadcast: `BROADCAST_DATABASE_URL`, separate local PostgreSQL on port 5433.
- Ledger: `LEDGER_DATABASE_URL`, separate local PostgreSQL on port 5434.
- Signer: no database URL or database access.
- ActivityListener: `ACTIVITY_DATABASE_URL`, separate local PostgreSQL on port 5435.
- Sweep: `SWEEP_DATABASE_URL`, separate local PostgreSQL on port 5436.
- User: `USER_DATABASE_URL`, separate local PostgreSQL on port 5437.

`npm run migrate` migrates all six service databases. For independent deployment use `npm run migrate:wallet`, `migrate:broadcast`, `migrate:ledger`, `migrate:activity`, `migrate:sweep`, or `migrate:user`, supplying only that application's URL. Each service should receive only its own database credentials. Separate databases may live on one PostgreSQL server with separate roles and access restrictions, or on separate servers as in Compose.

### Migration Reset

The earlier development reset established fresh Wallet, Broadcast, and Ledger baselines. Phase 2 preserves those baselines and adds exchange registry/accounting migrations plus an ActivityListener baseline. This direction adds User/Sweep baselines and additive Wallet/Ledger migrations that remove tenant columns and scope idempotency to the single owner. Historical migration SQL remains unchanged. Normal migration deployment applies these changes without resetting databases; no application database reset was performed for this implementation. The coordinated development reset remains a separate destructive setup procedure.

The baseline migration files are generated under each service's `apps/<service>/prisma/migrations` directory. Run `npm run migrate` to apply all six databases’ migrations, or use the application-specific migration commands separately. Each service continues to use its own database credentials. The wrapper no longer recognizes or baselines the former `schema_migrations` history.

Configure User private/Wallet public token keys with matching issuer/audience, the six application database URLs, `WALLET_API_KEY`, `EXCHANGE_API_KEY`, `EXCHANGE_DOMAIN_ID`, `REDIS_URL`, `QUEUE_PREFIX`, required `RESET_EPOCH`, `QUEUE_AUTH_KEY`, a distinct `LEDGER_API_KEY`, Pub/Sub project/topic/subscription settings, and provider RPC/network settings for a new environment. All workers and the external publisher must use the same epoch, and provider payloads must carry it as top-level `resetEpoch`. Stop old application versions before deploying the single-owner schema and message contracts; do not mix old tenant workers with the new services.

## Exchange accounting

Phase 2 provides customer liabilities and holds, immutable balanced journals, durable per-consumer registry delivery, and Ledger outbox/reconciliation. See [Phase 2 implementation notes](docs/exchange-wallet-phase2.md) for the internal API, migration setup, and verification. Customer address publication remains blocked until Phase 1 custody bootstrap and Phase 3 provider coverage are complete. Account 0 is the hot wallet, management accounts 1–9 remain reserved, and customer deposit accounts start at 10.

Phase 3 adds public `/v1/me` customer queries/assignments using User JWTs and private `/internal/customers` administration using `EXCHANGE_API_KEY`, scoped by `EXCHANGE_DOMAIN_ID`, durable address-watch/backfill readiness, RPC-verified transfer identities, reorg compensation, and custody-loss freezes. User registration now creates the financial customer through `user.registered.v1`; `userId`, `customerId`, and the customer's external ID are the same UUID. Wallet then registers that identity with Ledger through the queue; balances return HTTP 202 with `awaiting_ledger_registration` until acknowledgment. The former backend `POST /v1/customers` creation route has been removed. Address assignment waits for a registered customer account >=10 and all custody, Ledger, and listener coverage prerequisites. QuickNode is selected for Ethereum/Solana; its gateway implementation and live certification in the external listener repository remain open. Bitcoin regtest has a separate observation gateway. Certificates default to empty, and no customer address is exposed without verified coverage. See [Phase 3 implementation notes](docs/exchange-wallet-phase3.md) for API routes, configuration, the gateway contract, and remaining rollout gates.

Sweep is a separate scheduling foundation. Ledger sends `deposit.credited.v1`, reversals, and custody review events to its own queue delivery. Sweep stores one work item per source wallet, asset, and reset epoch, preserves pending registry/hot-wallet dependencies, and keeps review gates closed after incident compensation. Its `observed_credit_units` field is a scheduling hint, not a spendable balance. Phase 4 now supplies independent authorization, canonical preparation, same-byte Broadcast retries and custody-only settlement. Phase 5 adds JWT-authenticated native withdrawals from hot0 with durable customer holds, serialized hot resources, safe cancellation and reorg recovery. Both `ENABLE_NATIVE_SWEEPS` and `ENABLE_NATIVE_WITHDRAWALS` default to false; broadcast remains disabled. See [Phase 4 notes](docs/exchange-wallet-phase4.md) and [Phase 5 API and execution notes](docs/exchange-wallet-phase5.md).

Phase 6 local implementation is complete: certified ERC-20/SPL deposits, management1 gas funding and SPL sponsorship, token-first residual sweeps, hot0 withdrawals, and actual native fee/rent accounting are integrated. Independent signing authorizations, resource claims, original withdrawal holds and canonical reversal remain enforced. Token execution/signing default to false; live activation requires the separate QuickNode gateway certification, actual asset certificates and funded/accounted native fee capital. See [Phase 6 implementation and activation notes](docs/exchange-wallet-phase6.md).

## User registration and login

`POST http://127.0.0.1:3001/v1/users/register` accepts only `{ "email": "user@example.com", "password": "a sufficiently long password" }`. Emails are trimmed/lowercased and unique; passwords contain 15–128 Unicode characters and are preserved without trimming, normalization, or truncation. Successful registration returns HTTP 201 with only `userId`, normalized `email`, and `createdAt`. A duplicate email returns HTTP 409 and never updates the existing password.

User owns authentication records only. Its database transaction commits the user and an identity-only outbox event together; email, password, and password hash are never sent to financial queues. Wallet customer projection and Ledger registration happen asynchronously. Backend customer reads can return not found before the registration event is consumed; balances return the pending acknowledgment state afterward. No address is allocated or published merely because registration returned 201. `POST /v1/users/login` verifies the same email/password and returns `accessToken`, `tokenType: "Bearer"`, and `expiresIn` (default 900 seconds). Wallet verifies the signed RS256 token locally and scopes `/v1/me` to its subject; registration state is read from Wallet. Sessions/refresh/revocation, email verification, password reset, and MFA remain future work.

Passwords use asynchronous Node.js scrypt with `N=2^17`, `r=8`, `p=1`, a random 32-byte salt, and a 64-byte derived key, following [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt). Registration/login share a bounded hashing pool (`USER_HASH_CONCURRENCY`, default 2), reject excess work with HTTP 429, limit request bodies to 8 KiB, and apply independent per-process IP/global throttles. Default limits are five attempts per IP and thirty total attempts per minute. It uses the direct client address and does not trust forwarded IP headers. Login defaults to ten attempts per IP and sixty total attempts per minute; missing accounts perform the same password-hashing work and wrong credentials return a generic 401. Multiple replicas need shared edge throttling and deliberate trusted-proxy configuration; local limits still bound each process's hashing memory. See [the authentication contract](docs/user-authentication.md) for key settings, token claims, examples, and remaining features.

To register, save a valid email/password body in `register.json` and send it to User:

```sh
curl http://127.0.0.1:3001/v1/users/register \
  -H 'Content-Type: application/json' --data-binary @register.json
```

To log in, save the email/password in `login.json` and send it to User, then use the returned access token:

```sh
curl http://127.0.0.1:3001/v1/users/login \
  -H 'Content-Type: application/json' --data-binary @login.json
curl http://127.0.0.1:3000/v1/me/balances \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

## API changes

Public Wallet routes use `Authorization: Bearer <ACCESS_TOKEN>` from User login. `GET /v1/me`, deposit-address assignment/polling, balances, and deposit history derive the customer UUID from the token; customer ID overrides are rejected. Public assignments accept only configured Ethereum/Solana networks until Bitcoin custody support is ready. `GET /v1/me` returns 202 until registration reaches Wallet.

Private operational wallet routes require `WALLET_API_KEY`; `/internal/customers` administration uses `EXCHANGE_API_KEY`. There is no tenant selection. Neither service key authorizes `/v1/me`, and a customer JWT cannot authorize internal operations. `QUEUE_AUTH_KEY` authenticates internal events and must remain distinct from service credentials.

Swagger documents public `/v1/me` routes with JWT bearer authentication and excludes internal operations. The seven compatibility operational routes below remain private during the exchange transition. They are not customer withdrawal APIs; Phase 5 provides owner-scoped `/v1/me/withdrawals` paid only from hot0 when explicitly enabled.

**Command endpoints now return `202 Accepted`, not a completed synchronous result.** Poll the corresponding GET endpoint. Wallet creation can return `address: null` with `status: deriving`; wait for `ready` before requesting a transfer. Transaction acceptance does not guarantee preparation or signing succeeded; check the resulting status and generic `last_error` before requesting broadcast.

| Method | Route                                  | Result                                                                             |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------- |
| POST   | `/internal/wallets`                    | Accept or return wallet creation by external ID/chain/network for the single owner |
| GET    | `/internal/wallets/:id`                | Wallet status, address, derivation metadata                                        |
| GET    | `/internal/wallets/:id/balances`       | Confirmed and provisional Ledger balances by asset                                 |
| POST   | `/internal/wallets/:id/transactions`   | Accept preparation/signing; requires `Idempotency-Key`                             |
| GET    | `/internal/transactions/:id`           | Intent, prepared/signed data, hash, status, attempt count, generic error           |
| POST   | `/internal/transactions/:id/broadcast` | Queue broadcast, or retry an `attention` transaction with a new generation         |
| POST   | `/internal/transactions/:id/refresh`   | Restart bounded confirmation monitoring for a signed `attention` transaction       |

For example:

```sh
export API_KEY="$(node --env-file=.env -p 'process.env.WALLET_API_KEY')"
curl http://127.0.0.1:3000/internal/wallets \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"chain":"ethereum","externalId":"customer-001"}'
```

After the returned wallet is `ready`, save a transfer body as `transfer.json` and submit it:

```sh
curl "http://127.0.0.1:3000/internal/wallets/$WALLET_ID/transactions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: payment-001' --data-binary @transfer.json
```

Read confirmed and provisional wallet balances through the owner's backend API:

```sh
curl "http://127.0.0.1:3000/internal/wallets/$WALLET_ID/balances" \
  -H "Authorization: Bearer $API_KEY"
```

Amounts and Ethereum fee values are **decimal strings in base units**: wei for EVM, satoshis for Bitcoin-family chains, and lamports for Solana. Example bodies below contain placeholder recipients/outpoints that must be replaced.

```json
{
  "chain": "ethereum",
  "to": "0xREPLACE_WITH_40_HEX_CHARACTERS",
  "amount": "1000000000000000",
  "maxFeePerGas": "30000000000",
  "maxPriorityFeePerGas": "1000000000"
}
```

```json
{
  "chain": "bitcoin",
  "outputs": [
    { "address": "bc1qRECIPIENT_ONE", "amount": "10000" },
    { "address": "bc1qRECIPIENT_TWO", "amount": "20000" }
  ],
  "utxos": [{ "txid": "64_LOWERCASE_HEX_CHARACTERS", "vout": 0 }],
  "satsPerVbyte": 2
}
```

```json
{
  "chain": "solana",
  "outputs": [
    { "address": "BASE58_RECIPIENT_ONE", "amount": "1000000" },
    { "address": "BASE58_RECIPIENT_TWO", "amount": "2000000" }
  ]
}
```

Wait for `signed`, enable broadcasting on the broadcast service when ready, and POST to `/internal/transactions/TRANSACTION_ID/broadcast`. Submission and monitoring then run asynchronously.

## Delivery, retries, and scale

- **Transactional outbox:** state changes and their next action commit together in PostgreSQL. Database-owning producers run relays using `FOR UPDATE SKIP LOCKED`. A Redis outage leaves actions unpublished for a later attempt. Relays publish stable job IDs before marking delivery; a lost acknowledgement can safely cause redelivery. Ledger creates independent Wallet and Sweep deliveries of the same accounted deposit event.
- **Pub/Sub handoff:** ActivityListener acknowledges a provider Pub/Sub message only after the activity is accepted into its deterministic BullMQ job. Pub/Sub redelivery therefore reuses the same job ID; the provider listener remains outside this repository.
- **At-least-once processing:** this is not an exactly-once transport. Deterministic job IDs, durable signer-result inbox records, status checks, generation checks, and a partial unique database index absorb duplicates. Signed bytes remain immutable across broadcast retries.
- **Reservations:** one pending transaction per wallet, including `attention`, across all replicas. Rejected preparation/signing releases the reservation; uncertain sends do not. This prevents this system's nonce/UTXO conflicts, provided these wallets are not spent from externally.
- **Workers:** wallet, broadcast, and ledger concurrency is 8 per replica; activity-listener and sweep concurrency is 4; signer concurrency is 1 because cryptography is synchronous. User is an HTTP producer with bounded asynchronous password hashing and an outbox relay. Add replicas with the same application-specific database, queue prefix, Redis, Pub/Sub subscription, network config, and appropriate secret credentials. Distinct environments require distinct databases and queue namespaces.
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

The CLI can also inspect `wallet-actions`, `signer-actions`, `activity-actions`, `ledger-actions`, and `sweep-actions`. User registration events enter `wallet-actions`; User does not need an incoming worker queue for this initial scope. Rejected preparation/signing needs a corrected request with a new idempotency key; replaying a command whose database state is already terminal is a no-op. Queue authentication failures require correcting the producer/key configuration, not blindly retrying.

PostgreSQL outbox/inbox records are retained for recovery and currently have no automatic cleanup policy. Redis persistence/backups remain necessary: the outbox protects the database-to-queue handoff, not total loss of acknowledged Redis data. Restore Redis or deliberately replay affected outbox actions after such a loss. Do not flush production queues. The shared queue key authenticates internal messages; independent exchange spending-policy enforcement remains separate work.

## Prisma and deployment

`apps/wallet/prisma`, `apps/broadcast/prisma`, `apps/ledger/prisma`, `apps/activity-listener/prisma`, `apps/sweep/prisma`, and `apps/user/prisma` contain independent schemas and migrations. Their configuration files are `prisma.config.ts`, `prisma.broadcast.config.ts`, `prisma.ledger.config.ts`, `prisma.activity.config.ts`, `prisma.sweep.config.ts`, and `prisma.user.config.ts`. `npm run db:generate` generates all six clients. Ordinary queries and writes use Prisma Client with the PostgreSQL adapter. Database sessions use UTC so delayed actions retain their intended timestamps. Small parameterized raw queries remain for row/advisory locks, `SKIP LOCKED`, and the existing non-recycling account sequence. Partial unique indexes and CHECK constraints are maintained in migration SQL; do not replace migrations with `db push`.

The Dockerfile provides a non-root runtime for any service. Override its command for user, sweep, signer, broadcast, activity-listener, or ledger. Build the `migrate` target to run `node dist/scripts/migrate.js` with the Prisma CLI available. Mount the seed read-only only in signer containers, owned by UID 1000 with mode 0600. Other services do not need seed access.

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
TEST_SWEEP_DATABASE_URL=postgresql://user:password@localhost:5436/sweep_test \
TEST_USER_DATABASE_URL=postgresql://user:password@localhost:5437/user_test \
TEST_REDIS_URL=redis://localhost:6379 npm test
npm run format:check
npm run lint
npm audit
```

Tests run serially against six dedicated test databases. Exchange journal fixtures use unique domains and preserve append-only history; operational fixtures clean only their own records. The outbox interruption test creates and drops its own temporary database, so the dedicated Ledger test role needs database-creation permission. The integration suite starts real NestJS processes and multiple broadcast replicas, uses real Redis and PostgreSQL, and mocks blockchain RPC. Ledger integration tests cover deduplication, provisional-to-confirmed promotion, attention recovery, and reorg reversal; ActivityListener tests cover finality mapping and RPC retry exhaustion. It exercises offline consumers, async signing, signature verification, retries, lost responses after acceptance, duplicate delivery, single-owner backend authentication, idempotency, outbox recovery, generation checks, reservation retention, and automatic confirmation. Pub/Sub ingestion is unit-tested; no test sends live funds. CI supplies all six PostgreSQL databases and Redis. Phase 2 tests cover simultaneous holds, per-asset balancing, immutable journals, duplicate/reordered events, deficit freezing, custody-only movements, actual fees, settlement reversal, registry acknowledgments, and a lost Redis acknowledgment after a committed reservation. User tests cover exact password handling, secure hashing, throttling, duplicate registration races, transactional provisioning, and secret-free events/responses; Sweep tests cover source/asset work coalescing, registry dependencies, and custody review gates without execution emissions.

References: [NestJS queues](https://docs.nestjs.com/techniques/queues), [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [Prisma PostgreSQL integration](https://www.prisma.io/docs/orm/overview/databases/postgresql), [Prisma baselining](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining), [Wallet Core usage](https://developer.trustwallet.com/developer/wallet-core/integration-guide/wallet-core-usage).


Phase 7 adds private audited recovery, canonical custody reconciliation, queue repair and operational metrics/alerts. Monitoring defaults to false and requires Wallet/Ledger migrations; private controls need the distinct operations key as well as Wallet backend authentication. It never enables spending or releases uncertain holds. See [operational controls and runbooks](docs/exchange-wallet-phase7.md).

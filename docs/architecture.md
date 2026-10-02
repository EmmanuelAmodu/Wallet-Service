# NestJS architecture

Each application has a small `main.ts` and a root `AppModule`. The root imports configuration, infrastructure, and feature modules. Controllers and processors are transport adapters; injectable services implement application behavior. Modules export only providers needed by another module.

## Application structure

```text
apps/
  wallet/src/
    app.module.ts
    main.ts
    config/           # Namespaced, validated wallet settings
    auth/             # Global tenant guard and @Tenant() decorator
    prisma/           # WalletPrismaModule and WalletPrismaService
    wallets/          # Wallet creation/query controller, DTO, and service
    transactions/     # Transaction command/query controller, DTO, and service
    messaging/        # BullMQ processor and wallet workflow service
  broadcast/src/
    app.module.ts
    main.ts
    config/
    prisma/           # Separate BroadcastPrismaModule and client
    broadcast/        # Processor, application service, RPC service
  activity-listener/src/
    app.module.ts
    main.ts
    config/           # Pub/Sub subscription and finality polling settings
    activity-pubsub.service.ts # Ack only after durable queue handoff
    activity.processor.ts     # Authenticated activity/finality consumer
    activity-workflow.service.ts # Chain mapping, RPC finality, ledger events
  ledger/src/
    app.module.ts
    main.ts
    config/           # Separate database and internal API settings
    prisma/           # Independent ledger database client
    ledger.controller.ts # Internal register/balance endpoints
    ledger.processor.ts  # Wallet registration and ledger event consumer
    ledger.service.ts    # Double-entry journal and per-entry balances
  signer/src/
    app.module.ts
    main.ts
    config/
    signing/          # Processor, signing service, Wallet Core adapter
packages/
  queue/src/          # MessagingModule, OutboxModule, message contracts
  chain/src/          # ChainModule, injectable RPC client, network configuration
  shared/src/         # Validation contracts, HTTP pipe/filter, security helpers
  database/src/       # Database-independent PostgreSQL locking helpers
```

Prisma schemas and migrations remain under each owning application's `prisma/` directory. No application imports another application's implementation. ESLint checks this boundary and prevents application code outside configuration factories from reading `process.env` directly.

## Request handling

`AuthModule` registers `TenantAuthGuard` using `APP_GUARD` for Wallet-Service routes. The guard requires a tenant Bearer credential and resolves its tenant; `@Tenant()` supplies that identity to controllers. Swagger is public, wallet/transaction routes require tenant credentials, and Ledger's `/internal` routes require the separate `LEDGER_API_KEY`. Unknown routes return Nest's normal 404 response.

Controllers declare their request types in `dto/` and bind `ZodValidationPipe` to bodies and idempotency keys. UUID parameters use Nest's `ParseUUIDPipe`. We retain the existing Zod schemas as the single runtime contract for chain-specific unions, decimal amounts, and strict input objects; duplicating those rules in class-validator DTOs would create two sources of truth. DTO types are inferred from those schemas. The `/docs` UI and `/docs-json` OpenAPI document are public; tenant authentication applies to wallet and transaction controller routes.

`SafeErrorsFilter` is registered through `APP_FILTER`. It reports safe validation details and HTTP errors without serializing internal database, SDK, or RPC failures.

`WalletsService` handles wallet creation and lookup. `TransactionsService` handles transaction creation, reservations, idempotency, and broadcast/refresh commands. `LedgerClient` forwards authenticated balance reads to Ledger; Wallet-Service never reads the Ledger database. Wallet derivation results enqueue `ledger.wallet.registered` in the same wallet database transaction that marks the wallet ready. We do not add a repository wrapper that merely repeats Prisma methods; introduce a domain-specific repository only when it consolidates a reusable query or invariant.

## Queue handling

`MessagingModule` configures BullMQ with `forRootAsync`, injecting the validated queue configuration. Queue names, message contracts, authentication, retries, and retention remain shared.

Processors authenticate envelopes, translate BullMQ attempt metadata, delegate to an application service, and translate `ActionRejectedError` into a non-retryable BullMQ error. Application services do not depend on BullMQ `Job` or `WorkerHost` types:

- `WalletWorkflowService` prepares transactions and applies signer/broadcast events to wallet state.
- `BroadcastService` owns signed payload persistence, reconciliation, retry state, and confirmation monitoring.
- `SigningService` delegates cryptographic operations to `SigningCore` and produces success/rejection events.
- `ActivityPubSubService` validates Pub/Sub input and enqueues it before acknowledging the source message. `ActivityWorkflowService` maps source chain aliases, verifies the configured RPC network, and polls for finality.
- `LedgerService` resolves event wallet identifiers only to registered wallets, writes balanced debit/credit entries per asset and balance state, stores running balances and linked account-entry history, and reverses replaced block postings in its own database.

The signer processor publishes its result before acknowledging its input job. Wallet and broadcast commit outgoing messages to their own transactional outbox. Pub/Sub-to-Redis delivery uses a stable job ID derived from the Pub/Sub message ID; Ledger activity job IDs are deterministic and the ledger transaction ID is the provider activity identifier. `OutboxModule.register()` binds the shared relay to the application's Prisma provider through an injection token; it never selects another application's database.

Wallet, broadcast, and ledger each own an independent database. Immutable signed payloads, generation/revision guards, durable outbox/inbox processing, and wallet reservations until a terminal outcome remain enforced. Ledger balance changes and journal rows commit in one database transaction. The wallet API's broadcast state is eventually consistent; ledger reads go through the internal Ledger API.

## Configuration and lifecycle

`@nestjs/config` loads `.env` for local development and namespaced `registerAs` factories. Process environment values take precedence. Production deployments should supply only the owning service's settings and omit local `.env` files.

Configuration factories validate required values, numeric bounds, unique tenant keys, distinct tenant/queue credentials, and the broadcast enable flag. Production also requires a Ledger API key distinct from both tenant and queue keys. Application providers receive typed settings through dependency injection. The signer requires no database, wallet API keys, or RPC endpoint. ActivityListener uses Google Cloud credentials and a Pub/Sub subscription; Ledger owns its database and internal API key.

Wallet, broadcast, and Ledger Prisma services connect during `OnModuleInit` and disconnect during `OnApplicationShutdown`. Processors drain their workers in `BeforeApplicationShutdown`. `ActivityPubSubService` closes its subscription/client during shutdown; `SigningService` owns disposal of the Wallet Core adapter after workers drain. The outbox relay stops its timer and finishes an active flush during module destruction; any later worker outbox writes remain durable for the next process.

## Build and extension workflow

`nest-cli.json` declares all five applications. `npm run build` cleans generated output, generates the wallet, broadcast, and ledger Prisma clients, builds every app with Nest CLI, and compiles tests/migration tools. `npm run build:wallet`, `build:signer`, `build:broadcast`, `build:activity-listener`, and `build:ledger` build one application. Corresponding `dev:*` scripts use Nest watch mode. Keep the TypeScript compiler for decorator metadata and unbundled Prisma/WASM assets.

Add a feature inside its owning application, register its service/controller in a feature module, and import that module from `AppModule`. Cross-application actions require a validated queue contract and idempotent consumer, not an import of the other application's service. State changes that schedule work must use the same Prisma transaction as the outbox write.

Use `@nestjs/testing` for module wiring and HTTP guard/pipe/filter tests. Keep real PostgreSQL/Redis integration tests for wallet, broadcast, and ledger transactional guarantees, plus independent cryptographic verification for signed transactions. Pub/Sub is tested at the activity workflow boundary; blockchain RPC is mocked in tests, and the suite never sends live funds.

References: [Nest feature modules](https://docs.nestjs.com/modules), [configuration](https://docs.nestjs.com/techniques/configuration), [BullMQ consumers](https://docs.nestjs.com/techniques/queues), [CLI workspaces](https://docs.nestjs.com/cli/monorepo).

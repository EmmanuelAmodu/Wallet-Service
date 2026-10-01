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

`AuthModule` registers `TenantAuthGuard` using `APP_GUARD`. The guard requires a Bearer credential and resolves its tenant; `@Tenant()` supplies that identity to controllers. All registered API routes are protected. Unknown routes return Nest's normal 404 response.

Controllers declare their request types in `dto/` and bind `ZodValidationPipe` to bodies and idempotency keys. UUID parameters use Nest's `ParseUUIDPipe`. We retain the existing Zod schemas as the single runtime contract for chain-specific unions, decimal amounts, and strict input objects; duplicating those rules in class-validator DTOs would create two sources of truth. DTO types are inferred from those schemas.

`SafeErrorsFilter` is registered through `APP_FILTER`. It reports safe validation details and HTTP errors without serializing internal database, SDK, or RPC failures.

`WalletsService` handles wallet creation and lookup. `TransactionsService` handles transaction creation, reservations, idempotency, and broadcast/refresh commands. They use the application-local Prisma provider so state changes and outbox writes stay in one database transaction. We do not add a repository wrapper that merely repeats Prisma methods; introduce a domain-specific repository only when it consolidates a reusable query or invariant.

## Queue handling

`MessagingModule` configures BullMQ with `forRootAsync`, injecting the validated queue configuration. Queue names, message contracts, authentication, retries, and retention remain shared.

Processors authenticate envelopes, translate BullMQ attempt metadata, delegate to an application service, and translate `ActionRejectedError` into a non-retryable BullMQ error. Application services do not depend on BullMQ `Job` or `WorkerHost` types:

- `WalletWorkflowService` prepares transactions and applies signer/broadcast events to wallet state.
- `BroadcastService` owns signed payload persistence, reconciliation, retry state, and confirmation monitoring.
- `SigningService` delegates cryptographic operations to `SigningCore` and produces success/rejection events.

The signer processor publishes its result before acknowledging its input job. Wallet and broadcast commit outgoing messages to their own transactional outbox. `OutboxModule.register()` binds the shared relay to the application's Prisma provider through an injection token; it never selects another application's database.

The separate-database guarantees remain unchanged: immutable signed payloads, generation/revision guards, durable outbox/inbox processing, and wallet reservations until a terminal outcome is received. The wallet API's broadcast state is eventually consistent.

## Configuration and lifecycle

`@nestjs/config` loads `.env` for local development and namespaced `registerAs` factories. Process environment values take precedence. Production deployments should supply only the owning service's settings and omit local `.env` files.

Configuration factories validate required values, numeric bounds, unique tenant keys, distinct tenant/queue credentials, and the broadcast enable flag. Application providers receive typed settings through dependency injection. The signer requires no database, wallet API keys, or RPC endpoint.

Each `PrismaService` connects during `OnModuleInit` and disconnects during `OnApplicationShutdown`. Processors drain their workers in `BeforeApplicationShutdown`. `SigningService` owns disposal of the Wallet Core adapter after workers drain. The outbox relay stops its timer and finishes an active flush during module destruction; any later worker outbox writes remain durable for the next process.

## Build and extension workflow

`nest-cli.json` declares all three applications. `npm run build` cleans generated output, generates both Prisma clients, builds the applications with Nest CLI, and compiles tests/migration tools. `npm run build:wallet`, `build:signer`, and `build:broadcast` build one application. `npm run dev:wallet`, `dev:signer`, and `dev:broadcast` use Nest watch mode. Keep the TypeScript compiler for decorator metadata and unbundled Prisma/WASM assets.

Add a feature inside its owning application, register its service/controller in a feature module, and import that module from `AppModule`. Cross-application actions require a validated queue contract and idempotent consumer, not an import of the other application's service. State changes that schedule work must use the same Prisma transaction as the outbox write.

Use `@nestjs/testing` for module wiring and HTTP guard/pipe/filter tests. Keep real PostgreSQL/Redis integration tests for transactional and delivery guarantees, and independent cryptographic verification for signed transactions. Blockchain RPC remains mocked in tests; the suite never sends live funds.

References: [Nest feature modules](https://docs.nestjs.com/modules), [configuration](https://docs.nestjs.com/techniques/configuration), [BullMQ consumers](https://docs.nestjs.com/techniques/queues), [CLI workspaces](https://docs.nestjs.com/cli/monorepo).
